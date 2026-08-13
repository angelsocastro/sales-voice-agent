import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents'
import { RoomEvent } from '@livekit/rtc-node'
import { TelephonyBackgroundVoiceCancellation } from '@livekit/noise-cancellation-node'
import { fileURLToPath } from 'node:url'
import {
  createCallOutcomeRecorder,
  createVoiceAgent,
  createSession,
  flushCrmWrites,
  prewarmTelnyxKimiClient,
  TEST_LEAD_CONTEXT,
  type CallOutcomeRecorder,
  type LeadContext,
} from './agent.js'
import { attachSessionObservability } from './observability.js'
import { getPromptConfig, loadPromptConfig } from './prompt-config.js'

const MAX_CALL_DURATION_MS = 8 * 60 * 1000

type CallMode = 'voice' | 'shadow'

/**
 * Silencio tolerado tras el descuelgue antes de que el agente abra él la
 * llamada. Mucha gente descuelga y espera a oír algo; sin esto la llamada se
 * quedaba muda hasta que colgaban. Lo dispara el veredicto del AMD (ver
 * `AMD_NO_SPEECH_TIMEOUT_MS`), no un timer suelto, para no hablar encima de la
 * locución de un contestador.
 */
const AMD_NO_SPEECH_TIMEOUT_MS = 2_500

// El prompt de clasificación que trae el SDK está en inglés y con ejemplos de
// EEUU. Mismas categorías y mismo formato de salida, pero con las locuciones
// reales que devuelven las operadoras españolas — que es lo que va a leer el
// clasificador en estas llamadas.
const AMD_PROMPT_ES = `Task:
Classify the call greeting transcript into exactly one of these categories:

human: A person answered (e.g., "¿Dígame?", "Sí, buenas.", "Distribuciones López, dígame").
machine-ivr: A menu or prompt to press a key (e.g., "Pulse 1 para hablar con un agente").
machine-vm: A voicemail greeting where leaving a message IS possible.
machine-unavailable: Any greeting indicating it's NOT possible to leave a message (phone off, out of coverage, mailbox full or not set up).
uncertain: For partial transcripts that are ambiguous.

Rule: a live person speaking counts as "human" no matter how long they talk
(a receptionist answering with the company name and a full greeting is still
human). Only classify as a machine when the text is clearly a recording, a
carrier announcement, or a menu. When in doubt between human and machine,
answer "uncertain".

The transcript is in Spanish (Spain). Examples:
Input: "El teléfono al que llama está apagado o fuera de cobertura en este momento."
Output: machine-unavailable

Input: "El buzón de voz del número marcado no está disponible en este momento."
Output: machine-unavailable

Input: "Ha llamado usted al buzón de voz del 6 1 2 3 4 5 6 7 8. Deje su mensaje después de la señal."
Output: machine-vm

Input: "Le atiende el contestador automático de Distribuciones López. Por favor, deje su mensaje."
Output: machine-vm

Input: "Gracias por llamar a Distribuciones López. Para pedidos, pulse 1. Para administración, pulse 2."
Output: machine-ivr

Input: "En este momento no podemos atenderle. Nuestro horario es de nueve a dos y de cuatro a siete."
Output: uncertain

Input: "¿Sí? ¿Dígame?"
Output: human

Input: "Distribuciones López, buenos días."
Output: human

Input: "Distribuciones López, buenos días, le atiende María, ¿en qué puedo ayudarle?"
Output: human`

// dial-script.ts pone el contexto real del lead (y opcionalmente `mode`) en
// el metadata del job al crear el dispatch (ver AgentDispatchClient.createDispatch
// en dial-script.ts). Sin metadata (ej. pruebas manuales sin dialer), cae al
// lead de test en modo voz — mismo comportamiento que antes de Modelo B.
function parseJobMetadata(rawMetadata: string): { lead: LeadContext; mode: CallMode } {
  if (!rawMetadata) return { lead: TEST_LEAD_CONTEXT, mode: 'voice' }
  try {
    const parsed = JSON.parse(rawMetadata)
    return {
      lead: {
        leadId: parsed.leadId ?? TEST_LEAD_CONTEXT.leadId,
        companyName: parsed.companyName ?? TEST_LEAD_CONTEXT.companyName,
        phone: parsed.phone ?? TEST_LEAD_CONTEXT.phone,
        notes: parsed.notes ?? TEST_LEAD_CONTEXT.notes,
      },
      mode: parsed.mode === 'shadow' ? 'shadow' : 'voice',
    }
  } catch (err) {
    console.error('job.metadata no es JSON válido, usando lead de test', err)
    return { lead: TEST_LEAD_CONTEXT, mode: 'voice' }
  }
}

/**
 * ¿Hay alguien realmente al otro lado? LiveKit publica el estado de la llamada
 * SIP como atributo del participante (`dialing` → `ringing` → `active`). En
 * pruebas sin SIP no hay atributo: se asume descolgado para no bloquear el
 * saludo.
 */
function isCallAnswered(ctx: JobContext): boolean {
  const participants = [...ctx.room.remoteParticipants.values()]
  if (participants.length === 0) return false
  return participants.some(p => {
    const status = p.attributes['sip.callStatus']
    return status === undefined || status === 'active'
  })
}

async function hangUp(ctx: JobContext, reason: string): Promise<void> {
  try {
    await ctx.deleteRoom()
  } catch (err) {
    console.error('Fallo al borrar la room al colgar', { reason, err })
  }
  ctx.shutdown(reason)
}

/**
 * Detección de contestador/IVR (AMD del SDK).
 *
 * En cold calling outbound una parte de las llamadas las coge un buzón o una
 * centralita. Sin esto, el agente le hacía el pitch entero a la locución y
 * acababa escribiendo en el CRM un resultado inventado (o dejando el lead sin
 * tocar hasta el timeout de 8 minutos).
 *
 * Mientras el AMD no tiene veredicto, el SDK retiene la respuesta del agente
 * (`pauseReplyAuthorization`), así que no hace falta coordinar nada más: si
 * contesta una persona, el veredicto llega en ~500ms tras su saludo y la
 * conversación sigue normal; si no contesta nadie, el veredicto `uncertain`
 * llega a los AMD_NO_SPEECH_TIMEOUT_MS y es la señal para saludar nosotros.
 */
function startAnsweringMachineDetection(
  ctx: JobContext,
  session: voice.AgentSession,
  recordOutcome: CallOutcomeRecorder,
): void {
  const amd = new voice.AMD(session, {
    interruptOnMachine: true,
    // No emitir el veredicto hasta que la locución termine: si dejáramos de
    // esperar a mitad del mensaje del contestador, colgaríamos encima.
    waitUntilFinished: true,
    noSpeechTimeoutMs: AMD_NO_SPEECH_TIMEOUT_MS,
    prompt: AMD_PROMPT_ES,
  })

  ctx.addShutdownCallback(async () => {
    await amd.aclose().catch(() => {})
  })

  amd.on('amd_prediction', event => {
    console.info('AMD: veredicto', {
      category: event.category,
      speechDurationMs: event.speechDurationMs,
      delayMs: event.delayMs,
      transcript: event.transcript,
    })

    if (event.isMachine) {
      console.warn('AMD: contestador/IVR detectado — cerrando llamada', {
        category: event.category,
      })
      recordOutcome({
        outcome: 'buzon_voz',
        resumen: `Contestador o centralita (${event.category}). No habló ninguna persona. Locución: "${event.transcript}".`,
      })
      void hangUp(ctx, 'answering_machine')
      return
    }

    // Nadie ha dicho nada tras descolgar: abre tú la llamada en vez de dejar
    // silencio. Si la persona ya había hablado, el turno normal se genera solo
    // al reanudarse la autorización de respuesta — aquí no hay que hacer nada.
    //
    // La comprobación de `sip.callStatus` evita el caso de que el veredicto
    // llegue por el timeout duro del AMD mientras el teléfono todavía está
    // sonando: ahí no hay nadie escuchando y saludar solo gasta TTS (y podría
    // pillar a la persona justo al descolgar, a mitad de frase).
    if (event.transcript.trim().length === 0 && isCallAnswered(ctx)) {
      console.info('AMD: descuelgue sin voz — el agente abre la llamada')
      session.generateReply({
        instructions:
          'Han descolgado pero no han dicho nada. Abre tú la llamada con el saludo ' +
          'de apertura del prompt, con normalidad.',
      })
    }
  })

  amd.execute().catch(err => {
    // Fail-open: si el AMD falla (o se cierra al colgar), la llamada sigue como
    // si hubiera contestado una persona. Nunca colgamos por una duda del AMD.
    console.error('AMD no pudo completarse — se continúa como llamada humana', err)
  })
}

/**
 * Red de seguridad de duración: el prompt le pide al LLM cerrar a los 8 min,
 * pero eso depende de que el modelo lo cumpla. Esto corta la llamada de verdad
 * pase lo que pase, aunque el LLM no invoque end_call.
 */
function armMaxCallDuration(ctx: JobContext): void {
  const timeoutHandle = setTimeout(() => {
    console.warn('MAX_CALL_DURATION alcanzado — forzando fin de llamada', {
      room: ctx.room.name,
    })
    void hangUp(ctx, 'max_call_duration')
  }, MAX_CALL_DURATION_MS)

  ctx.room.on('disconnected', () => {
    clearTimeout(timeoutHandle)
  })
}

export default defineAgent({
  // Corre una vez al arrancar el proceso worker, antes de que le asignen el
  // primer job — deja la conexión TCP/TLS a Telnyx ya abierta para cuando
  // llegue la primera llamada real. Ver comentario en agent.ts:
  // prewarmTelnyxKimiClient() para el porqué.
  prewarm: (_proc: JobProcess) => {
    prewarmTelnyxKimiClient()
    void loadPromptConfig()
  },
  entry: async (ctx: JobContext) => {
    const { lead, mode } = parseJobMetadata(ctx.job.metadata)
    const shadow = mode === 'shadow'
    const promptConfig = await getPromptConfig()
    // Un único recorder por llamada: lo comparten el tool end_call del LLM y la
    // detección de contestador, así el resultado se escribe como mucho una vez.
    const recordOutcome = createCallOutcomeRecorder(lead)
    const session = createSession(lead, { shadow, promptConfig })

    attachSessionObservability(session, { room: ctx.room.name, leadId: lead.leadId })

    // Las escrituras a Attio salen sin await para no meter HTTP en el turno de
    // despedida; esto garantiza que el proceso no muere con ellas a medias.
    ctx.addShutdownCallback(async () => {
      await flushCrmWrites()
    })

    await session.start({
      agent: createVoiceAgent(lead, recordOutcome, { shadow, promptConfig }),
      room: ctx.room,
      // Todo el tráfico de audio de entrada es SIP/PSTN (el lead) tanto en
      // modo voz como en modo shadow (el operador entra por WebRTC de navegador,
      // que no necesita este procesado) — BVCTelephony es el modelo de Krisp
      // tuneado para banda estrecha/comprimida de telefonía, mejor que el
      // BVC genérico aquí. En shadow sigue haciendo falta: es lo que oye el
      // STT del agente para generar las sugerencias.
      inputOptions: {
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    })

    await ctx.connect()

    // El AMD cuelga solo en cuanto detecta un contestador (interruptOnMachine),
    // sin que ningún humano lo confirme — eso está bien en modo voz (nadie más
    // está escuchando), pero rompería la regla de Modelo B de que solo el operador o
    // el propio lead terminan la llamada. En shadow, el operador está siempre
    // escuchando en vivo y puede juzgar él mismo si es un contestador y colgar
    // desde el dashboard, así que el AMD no se arma.
    if (!shadow) {
      startAnsweringMachineDetection(ctx, session, recordOutcome)
    }
    armMaxCallDuration(ctx)

    // Modelo B: no hay TTS que mantenga viva la sala, así que el agente no
    // tiene ninguna otra señal de que la llamada terminó salvo esta — en
    // cuanto se queda sin nadie real (el operador colgó desde el dashboard, o colgó
    // el lead, o los dos), no tiene sentido esperar al timeout de
    // MAX_CALL_DURATION_MS con el worker ocupado.
    if (shadow) {
      ctx.room.on(RoomEvent.ParticipantDisconnected, () => {
        if (ctx.room.remoteParticipants.size === 0) {
          void hangUp(ctx, 'sala vacía')
        }
      })
    }
  },
})

// El nombre con el que el worker se registra decide qué llamadas recibe: el
// dialer despacha por nombre (`createDispatch(room, agentName)` en
// dial-script.ts), no por dispatch rule. Por eso el agente de dev DEBE
// registrarse con otro nombre — si se llamara igual que el de producción, se
// repartiría con él las llamadas reales a leads.
//
// Viene del entorno (lo inyecta LiveKit desde los secretos del agente, que
// salen de Doppler) para que el mismo código sirva en los dos entornos. Mismo
// nombre de variable que usan el dialer y scripts/call.ts.
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME ?? 'outbound-agent',
  }),
)
