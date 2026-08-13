/**
 * Motor genérico del bot de voz outbound: cualifica al lead y agenda una
 * llamada de seguimiento con un humano. El guion real de negocio (identidad,
 * flujo, objeciones) se inyecta desde fuera — ver prompt-config.ts.
 *
 * STT/TTS: LiveKit Inference (Deepgram Nova-3 + Cartesia Sonic-3), colocado
 * en la misma región del agente (EU).
 *
 * LLM: Kimi K2.6 (moonshotai/Kimi-K2.6) vía Telnyx Inference API
 * (`openai.LLM.withTelnyx()`), no LiveKit Inference — Gemma 4 31B de
 * LiveKit Inference solo corre en US por ahora (confirmado por LiveKit, EU
 * "next", ~1-2 meses sin ETA fija a 2026-07), lo que añadía un roundtrip
 * transatlántico a cada turno. Kimi K2.6 gana también en índice de
 * inteligencia frente a las alternativas evaluadas (Llama 4 Scout/Groq,
 * Claude Haiku 4.5) — Telnyx lo etiqueta explícitamente "recomendado" para
 * voice AI (modo thinking disabled). Usa `TELNYX_API_KEY`, ya en `.env`,
 * sin credenciales nuevas que gestionar.
 *
 * El resto del stack de "LiveKit on Telnyx" (STT/TTS Telnyx, voz Ultra) no
 * se portó: el paquete `telnyx-livekit-plugin` que los da es Python-only,
 * sin soporte Node.js confirmado por el propio mantenedor
 * (github.com/team-telnyx/telnyx-livekit-plugin/issues/12 — "NodeJS is on
 * our roadmap, no ETA"). Si algún día se libera ese paquete o se completa
 * la migración a "LiveKit on Telnyx", el LLM ya está en Telnyx Inference —
 * solo faltaría mover STT/TTS para correr el stack entero ahí.
 */

import {
  AgentSessionEventTypes,
  getJobContext,
  inference,
  llm,
  voice,
} from '@livekit/agents'
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai'
import OpenAI from 'openai'
import { z } from 'zod'
import { recordCallOutcome, type CallOutcome } from './crm-outcome.js'
import { parseSpanishTime } from './time-parser.js'

// Kimi K2.6 tiene "thinking" activado por defecto en el Inference API de
// Telnyx: sin desactivarlo, el modelo razona en silencio varios segundos
// antes de responder (visto en producción: llm_node de 5-14s con TTFT de
// <1.2s — el hueco es razonamiento oculto, no lentitud real del proveedor;
// confirmado con curl directo: 114 completion_tokens y un campo `reasoning`
// separado para un simple "Hola.").
//
// OJO: el parámetro correcto es `enable_thinking: boolean` a nivel raíz del
// body — así lo define el OpenAPI oficial de Telnyx
// (developers.telnyx.com/api-reference/openai-chat/create-a-chat-completion-openai-compatible).
// `thinking: {type: "disabled"}` es la convención de la API directa de
// Moonshot, NO la de Telnyx — Telnyx la ignora en silencio sin dar error,
// así que probarlo a mano contra el endpoint real es la única forma fiable
// de pillar esto (ver curl de verificación en el historial de este cambio).
//
// `withTelnyx()` no expone `enable_thinking` en su lista tipada, así que se
// inyecta con un cliente OpenAI parcheado en el nivel HTTP.
export function createTelnyxKimiClient() {
  const client = new OpenAI({
    baseURL: 'https://api.telnyx.eu/v2/ai',
    apiKey: process.env.TELNYX_API_KEY,
  })
  const originalCreate = client.chat.completions.create.bind(client.chat.completions)
  client.chat.completions.create = ((body: unknown, opts: unknown) =>
    originalCreate(
      { ...(body as object), enable_thinking: false } as never,
      opts as never,
    )) as typeof client.chat.completions.create
  return client
}

// Singleton: un solo cliente HTTP por proceso worker, reutilizado entre
// llamadas (no uno nuevo por sesión) — así el connection pool con keep-alive
// se mantiene caliente después de la primera llamada real, y el prewarm de
// abajo tiene sentido (si creáramos un cliente nuevo por sesión, precalentar
// uno y descartarlo no serviría de nada).
let telnyxKimiClient: OpenAI | undefined

export function getTelnyxKimiClient() {
  telnyxKimiClient ??= createTelnyxKimiClient()
  return telnyxKimiClient
}

// LiveKit no tiene (todavía) un mecanismo oficial de prewarm para LLMs en
// Node — solo para VAD (ver `prewarm_fnc`/`setup_fnc` en sus docs). Hay un
// gap documentado por el propio equipo (github.com/livekit/agents#3240): los
// LLMs normalmente necesitan una request de inferencia real para "despertar
// el modelo", así que no lo prewarmean por defecto. Pero para APIs HTTP
// públicas como la de Telnyx, el modelo YA está corriendo — el coste real de
// la primera llamada es el handshake DNS+TCP+TLS del lado cliente, que sí se
// puede precalentar con una petición ligera de fondo (mismo patrón que un PR
// comunitario sin mergear para el plugin de Python, #3822). Verificado con
// curl: ~190ms de handshake que de otra forma se comen la primera respuesta
// real de la llamada.
export function prewarmTelnyxKimiClient() {
  getTelnyxKimiClient()
    .get('/', { headers: {} })
    .catch(() => {
      // Esperado: la ruta raíz no es un endpoint real (404). Solo interesa
      // el handshake TLS/TCP, no la respuesta.
    })
}

export const CARTESIA_ES_VOICE_ID =
  process.env.CARTESIA_ES_VOICE_ID ?? '538a8872-3799-4df5-b373-b78493b766c6'

// ---------------------------------------------------------------------------
// Config de turnos — TODAS LAS UNIDADES SON MILISEGUNDOS
// ---------------------------------------------------------------------------
// OJO al portar desde el agente Python (livekit-agent-py.bak/agent.py): allí la
// API es en SEGUNDOS (min_delay=0.3), aquí en MILISEGUNDOS. Los valores se
// copiaron literales en la migración, así que hasta ahora corría con
// minDelay=0.3ms / maxDelay=1.8ms / minDuration=0.5ms — es decir, sin ninguna
// tolerancia a pausas: el agente cerraba el turno en cuanto el VAD veía
// silencio (pisando al lead a mitad de frase) y cualquier ruido de fondo de
// medio milisegundo contaba como interrupción y lo callaba.
//
// Referencia del SDK: voice/turn_config/endpointing.d.ts (defaults 500/3000,
// y 300/2500 cuando el turn detector es de audio streaming como el nuestro) e
// interruption.d.ts (minDuration 500).
export const ENDPOINTING_OPTIONS = {
  mode: 'fixed',
  /** Espera mínima tras el fin de voz antes de dar el turno por cerrado. */
  minDelay: 300,
  /**
   * Techo de espera cuando el TurnDetector predice que el lead NO ha terminado.
   * 1800 en vez de los 2500 del SDK: con frases cortas o ambiguas el detector
   * se pegaba al máximo y la respuesta se sentía lenta (medido en los logs del
   * agente Python, donde estos valores sí estaban en la unidad correcta).
   */
  maxDelay: 1800,
} as const

export const INTERRUPTION_OPTIONS = {
  /** Distingue interrupción real de un "ajá" de fondo — mejor que VAD puro. */
  mode: 'adaptive',
  /** Duración mínima de voz para considerarlo interrupción. */
  minDuration: 500,
  /**
   * Exige al menos una palabra reconocida por el STT antes de callar al agente.
   * Es la protección clave en llamadas a naves y bares: sin esto, un golpe, una
   * carretilla o un crujido de línea cortan al agente a mitad del pitch. Cuesta
   * ~150-300ms de reacción ante una interrupción legítima; en cold calling
   * ruidoso ese trade-off sale a favor.
   */
  minWords: 1,
  /** Si tras interrumpir no llega transcripción, se reanuda lo que iba diciendo. */
  falseInterruptionTimeout: 2000,
  resumeFalseInterruption: true,
} as const

export const PREEMPTIVE_GENERATION_OPTIONS = {
  enabled: true,
  /**
   * Sintetiza también el TTS antes de confirmar el fin de turno: saca el TTFB
   * de Cartesia del camino crítico. Se paga alguna síntesis descartada cuando
   * el lead sigue hablando.
   */
  preemptiveTts: true,
} as const

// VAD: los defaults del SDK (50ms de voz mínima, 250ms de silencio, umbral
// 0.5) están pensados para micrófono de escritorio. En telefonía de banda
// estrecha con ruido de fondo constante conviene exigir un poco más de
// evidencia antes de declarar "hay voz" — espeja el tuning que ya tenía el
// agente Python (silero.VAD.load(min_silence_duration=0.4, min_speech_duration=0.1)).
export const VAD_OPTIONS = {
  minSpeechDuration: 100,
  minSilenceDuration: 400,
  activationThreshold: 0.6,
} as const

export interface LeadContext {
  leadId: string
  companyName: string
  phone: string
  notes: string
}

export const TEST_LEAD_CONTEXT: LeadContext = {
  leadId: '',
  companyName: '(sin asignar — test)',
  phone: '(sin asignar — test)',
  notes: '',
}

/**
 * Keyterms de dominio (el guion real vive en prompt-config.ts, cargado desde
 * DB) — vacío por defecto: sin negocio configurado no hay vocabulario que
 * sesgar más allá del nombre de la empresa del lead.
 */
export const DEFAULT_KEYTERMS: string[] = []

/**
 * Keyterms para el STT (Deepgram Nova-3 los acepta también en multilingüe, no
 * solo en inglés). Añade el nombre de la empresa del lead: es justo la palabra
 * que más se repite en la llamada y la que peor transcribe un modelo genérico
 * (nombres comerciales, apellidos, topónimos).
 */
export function buildKeyterms(
  lead: LeadContext = TEST_LEAD_CONTEXT,
  baseKeyterms: string[] = DEFAULT_KEYTERMS,
): string[] {
  const company = lead.companyName?.trim() ?? ''
  const usable =
    company.length > 1 && company.length <= 60 && !company.startsWith('(sin asignar')
  return usable ? [...baseKeyterms, company] : [...baseKeyterms]
}

// El contexto real viene del metadata del job de LiveKit, puesto por
// dial-script.ts al crear el dispatch — ver main.ts. TEST_LEAD_CONTEXT es
// solo el fallback para pruebas manuales sin dialer de por medio.
//
/**
 * Placeholder de ejemplo — el guion real de negocio vive fuera de este repo
 * (ver prompt-config.ts, cargado desde DB). Esto solo demuestra la forma que
 * tiene que tener un template: identidad, objetivo, flujo, objeciones, reglas
 * de cierre — no es contenido de producción.
 */
export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `\
# Identidad
Eres Ava, la asistente virtual de Acme Order Co. Sustituye este template por
el guion real de tu negocio (ver prompt-config.ts) — esto es solo un ejemplo
de la estructura esperada: identidad, objetivo, flujo de conversación,
objeciones y reglas de cierre.

# Objetivo
Cualificar al lead y agendar una llamada de seguimiento con un humano.

# Flujo
Saluda, identifícate como asistente virtual, confirma que hablas con la
persona correcta, haz 2-3 preguntas de cualificación, y si hay interés,
agenda una llamada de seguimiento. Si no hay interés, agradece y cierra.

# Reglas
- Una pregunta por turno.
- Invoca la función end_call para terminar la llamada, nunca solo digas la despedida.
- No inventes precios, funcionalidades ni compromisos fuera de este prompt.`

// El bloque variable (datos del lead) va al FINAL del prompt a propósito: todo
// lo que hay antes es idéntico en todas las llamadas, así que el proveedor
// puede reutilizar el prefijo cacheado en vez de re-prefillar ~9k caracteres
// en cada turno de cada llamada. Con el bloque del lead arriba —como estaba—
// el prompt entero cambiaba en la primera línea útil y no cacheaba nada.
export function buildSystemPrompt(
  lead: LeadContext = TEST_LEAD_CONTEXT,
  template: string = DEFAULT_SYSTEM_PROMPT_TEMPLATE,
): string {
  return `${template}

# Contexto de esta llamada
Empresa: ${lead.companyName}
Teléfono: ${lead.phone}
Notas: ${lead.notes}

Si hay notas, úsalas para adaptar la llamada. Por ejemplo: si dice "hablar con María", pregunta por María. No menciones que tienes notas.
`
}

// La escritura a Attio se lanza sin await para no meter una llamada HTTP en el
// camino del turno de despedida (el lead notaría el silencio). Pero justo
// después el tool arranca el apagado del job, así que sin esto el proceso podía
// morir con el fetch a medias y perder el resultado de la llamada — exactamente
// el fallo que este tool existe para arreglar. Se registran aquí y main.ts las
// espera en un shutdown callback.
const pendingCrmWrites = new Set<Promise<unknown>>()

export function trackCrmWrite(write: Promise<unknown>): void {
  pendingCrmWrites.add(write)
  void write.finally(() => pendingCrmWrites.delete(write))
}

export async function flushCrmWrites(): Promise<void> {
  await Promise.allSettled([...pendingCrmWrites])
}

// Reemplaza beta.createEndCallTool() del SDK — esa versión solo colgaba,
// sin escribir nada al CRM. Antes de la migración a LiveKit, esto lo hacía
// el MCP viejo (src/tools/end-call.ts + schedule-callback.ts en el repo
// raíz) que el Telnyx AI Assistant invocaba — dejó de dispararse al migrar,
// así que call_attempts/next_attempt/status llevaban parados desde entonces
// (ver handoff-migracion-attio.md). Mismo nombre de tool ("end_call") a
// propósito, para no tener que tocar cada "invoca end_call" del prompt.
//
// La secuencia de cierre (esperar a que suene la despedida, luego
// jobCtx.shutdown()+deleteRoom) replica beta.createEndCallTool() — no la
// reinventamos, solo le añadimos la escritura a Attio antes de devolver el
// texto de despedida al LLM.
/**
 * Escribe el resultado de la llamada en Attio, como mucho una vez por llamada.
 *
 * La idempotencia importa porque hay dos caminos que pueden cerrar la llamada:
 * el LLM invocando end_call (y el prompt contempla explícitamente que se
 * invoque más de una vez si llega otro turno mientras suena la despedida) y la
 * detección de contestador en main.ts. Sin la guarda, un lead podía acabar con
 * call_attempts incrementado dos veces y dos notas duplicadas.
 */
export function createCallOutcomeRecorder(lead: LeadContext) {
  let recorded = false

  return function recordOutcome(input: {
    outcome: CallOutcome
    resumen: string
    textoHora?: string
  }): void {
    if (recorded) return
    recorded = true

    if (!lead.leadId) return

    const apiKey = process.env.ATTIO_API_KEY
    if (!apiKey) {
      console.error('ATTIO_API_KEY no configurada — no se registra el resultado de la llamada')
      return
    }

    let nextAttemptISO: string | undefined
    if (input.textoHora) {
      const parsed = parseSpanishTime(input.textoHora)
      if (parsed) nextAttemptISO = parsed.toISOString()
    }

    const taskText =
      input.outcome === 'callback'
        ? `Volver a llamar — reagendado: ${input.textoHora ?? input.resumen}`
        : input.outcome === 'piloto_agendado'
          ? `El operador llama con el piloto montado — ${input.textoHora ?? 'sin hora concreta'}`
          : undefined

    trackCrmWrite(
      recordCallOutcome(apiKey, {
        leadId: lead.leadId,
        outcome: input.outcome,
        resumen: input.resumen,
        nextAttemptISO,
        taskText,
      }).catch(err => console.error('recordCallOutcome falló', { leadId: lead.leadId, err })),
    )
  }
}

export type CallOutcomeRecorder = ReturnType<typeof createCallOutcomeRecorder>

// opts.skipShutdown — Modelo B (copiloto de voz humana): el agente ya no cuelga
// la sala. El operador decide cuándo termina la llamada (botón del dashboard) o la
// termina el propio lead colgando su teléfono — nunca el LLM. Con
// skipShutdown, end_call sigue escribiendo el resultado en Attio (sigue
// siendo la única fuente de esa clasificación) pero no toca jobCtx/session.
// Exportada solo para poder testear opts.skipShutdown sin credenciales
// LiveKit/judge en vivo (ver tests/end-call-tool.test.ts) — no se usa fuera
// de este módulo en producción, createVoiceAgent sigue siendo el punto
// de entrada real.
export function createEndCallTool(
  recordOutcome: CallOutcomeRecorder,
  opts: { skipShutdown?: boolean } = {},
) {
  return llm.tool({
    name: 'end_call',
    description: opts.skipShutdown
      ? 'Registra el resultado de la llamada para el CRM. NO cuelga ni desconecta a nadie — ' +
        'eso lo decide la persona al teléfono. Úsala en cualquier punto donde el prompt diga ' +
        "'cuelga' o 'usa Hang Up' para clasificar qué pasó, pero la conversación puede seguir " +
        'después: si llega otro turno, sigue sugiriendo con normalidad en vez de callarte.'
      : "Termina la llamada y desconecta. Úsala en cualquier punto donde el prompt diga " +
        "'cuelga' o 'usa Hang Up': tras cerrar, descalificar, agendar, o si el lead deja " +
        'de responder. No generes más texto tras invocarla salvo la despedida que ya ' +
        'hayas generado en la misma respuesta.',
    parameters: z.object({
      resultado: z
        .enum(['piloto_agendado', 'descalificado', 'no_decisor', 'callback', 'opt_out', 'contacto_malo'])
        .describe(
          'piloto_agendado: dolor confirmado, productos recogidos, el operador llamará con el ' +
            'piloto montado. descalificado: sin dolor en ningún ángulo, o descalificación ' +
            'rápida, o "no me interesa". no_decisor: no se consiguió pasar con el decisor ' +
            'tras los intentos permitidos. callback: el lead dio fecha/hora concreta para ' +
            'volver a llamar (ej. "llámame en septiembre"). opt_out: dijo explícitamente ' +
            'que no le llamen más (LOPDGDD/Ley 11/2022) — máxima prioridad. contacto_malo: ' +
            'número equivocado o no es el negocio correcto.',
        ),
      resumen: z.string().describe('2-3 frases: qué pasó en la llamada, para la nota del CRM.'),
      texto_hora: z
        .string()
        .optional()
        .describe(
          'Solo si resultado=callback o piloto_agendado: cuándo, en el texto tal cual lo ' +
            'dijo el lead (ej. "mañana a las 10", "el martes por la tarde", "en septiembre").',
        ),
    }),
    execute: async ({ resultado, resumen, texto_hora }, { ctx }) => {
      recordOutcome({
        outcome: resultado as CallOutcome,
        resumen,
        textoHora: texto_hora,
      })

      if (opts.skipShutdown) {
        return (
          'Resultado registrado en el CRM. No cierres la conversación ni asumas que ya ' +
          'terminó — sigue escuchando y sugiriendo si llega otro turno.'
        )
      }

      // --- de aquí abajo, comportamiento idéntico a beta.createEndCallTool() ---
      // (ctx.speechHandle es el turno actual — incluye la despedida que el LLM
      // genera a partir del texto devuelto abajo; el mecanismo de LiveKit ata
      // esa generación al mismo speech handle del tool call, por eso funciona
      // esperar aquí en vez de a un evento "goodbye created" separado).
      const session = ctx.session
      session.once(AgentSessionEventTypes.Close, event => {
        const jobCtx = getJobContext(false)
        if (!jobCtx) return
        jobCtx.addShutdownCallback(async () => {
          console.info('deleting the room because the user ended the call')
          await jobCtx.deleteRoom()
        })
        jobCtx.shutdown(String(event?.reason ?? 'end_call'))
      })
      ctx.speechHandle.addDoneCallback(() => {
        session.shutdown()
      })

      return (
        'Di la frase de despedida que corresponda según el prompt (ya la habrás ' +
        'generado en tu respuesta) y termina la llamada.'
      )
    },
  })
}

// Modelo B (copiloto): sustituye la síntesis de voz. En vez de convertir el
// texto del turno en audio, lo junta entero y lo manda por un LiveKit text
// stream (topic 'suggestions') — el dashboard del operador lo pinta y él decide
// qué decir y cuándo, con su propia voz. Devolver `null` (en vez de un
// stream de AudioFrame) es lo que hace que este nodo del pipeline no
// produzca ningún audio — así el agente se queda mudo en la sala sin tocar
// STT/LLM/turn-taking, que siguen exactamente igual que en modo voz.
async function suggestionTtsNode(
  _ctx: unknown,
  text: AsyncIterable<string>,
): Promise<null> {
  let full = ''
  for await (const chunk of text) full += chunk

  const jobCtx = getJobContext(false)
  if (jobCtx?.room.localParticipant && full.trim()) {
    await jobCtx.room.localParticipant.sendText(full, { topic: 'suggestions' })
  }
  return null
}

/**
 * El guion real (template + keyterms) se inyecta desde fuera — ver
 * prompt-config.ts, que lo carga de DB con fallback a los defaults de
 * ejemplo de este archivo. Nada de este módulo sabe qué negocio lo usa.
 */
export interface PromptConfig {
  template: string
  keyterms: string[]
}

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  template: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  keyterms: DEFAULT_KEYTERMS,
}

// opts.shadow — Modelo B: mismo prompt/tools que el modo voz (nada del
// guion cambia), pero end_call no cuelga (ver createEndCallTool) y ttsNode
// redirige el texto del turno al dashboard en vez de a síntesis de voz (ver
// suggestionTtsNode).
export function createVoiceAgent(
  lead: LeadContext = TEST_LEAD_CONTEXT,
  recordOutcome: CallOutcomeRecorder = createCallOutcomeRecorder(lead),
  opts: { shadow?: boolean; promptConfig?: PromptConfig } = {},
) {
  const promptConfig = opts.promptConfig ?? DEFAULT_PROMPT_CONFIG
  return voice.Agent.create({
    instructions: buildSystemPrompt(lead, promptConfig.template),
    tools: [createEndCallTool(recordOutcome, { skipShutdown: opts.shadow })],
    ...(opts.shadow ? { ttsNode: suggestionTtsNode } : {}),
  })
}

export function createSession(
  lead: LeadContext = TEST_LEAD_CONTEXT,
  opts: { shadow?: boolean; promptConfig?: PromptConfig } = {},
) {
  const promptConfig = opts.promptConfig ?? DEFAULT_PROMPT_CONFIG
  return new voice.AgentSession({
    stt: new inference.STT({
      model: 'deepgram/nova-3',
      language: 'es',
      // numerals: "veinte" → "20" en el transcript. El LLM lee cantidades de
      // pedidos y horas ("sobre las diez y media") mucho mejor en cifras.
      modelOptions: { numerals: true },
      // Fallback server-side de LiveKit Inference: si Deepgram se cae o
      // degrada, la llamada sigue con otro proveedor en vez de quedarse muda.
      // universal-streaming-multilingual soporta es/es-ES según la tabla de
      // modelos de LiveKit.
      fallback: ['assemblyai/universal-streaming-multilingual'],
    }),
    // client custom: dominio de ingreso EU (api.telnyx.eu — el ingress domain
    // determina la región de GPU de Telnyx Inference, no la data locality de
    // la cuenta; por defecto withTelnyx() usa api.telnyx.com → US/Atlanta) +
    // thinking desactivado (ver createTelnyxKimiClient arriba).
    llm: OpenAILLM.withTelnyx({
      model: 'moonshotai/Kimi-K2.6',
      client: getTelnyxKimiClient(),
    }),
    // Modo shadow (Modelo B): sin tts — el agente nunca habla (ver
    // suggestionTtsNode en createVoiceAgent). Quien habla de verdad es
    // el operador, por micrófono de navegador, como un participante más de la sala.
    ...(opts.shadow
      ? {}
      : {
          tts: new inference.TTS({
            model: 'cartesia/sonic-3',
            voice: CARTESIA_ES_VOICE_ID,
            language: 'es',
          }),
        }),
    turnHandling: {
      turnDetection: new inference.TurnDetector(),
      endpointing: { ...ENDPOINTING_OPTIONS },
      interruption: { ...INTERRUPTION_OPTIONS },
      preemptiveGeneration: { ...PREEMPTIVE_GENERATION_OPTIONS },
    },
    // El VAD bundled (silero) no necesita prewarm propio en Node — el SDK lo
    // precarga — pero sí conviene tunearlo para telefonía ruidosa (ver VAD_OPTIONS).
    vad: new inference.VAD({ model: 'silero', ...VAD_OPTIONS }),
    keytermsOptions: { keyterms: buildKeyterms(lead, promptConfig.keyterms) },
  })
}
