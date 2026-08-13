/**
 * Llamadas ENTRANTES (Modelo B) — ver scripts/ensure-inbound-trunk.ts para
 * la infraestructura y el porqué no hace falta Telnyx Call Control: un
 * participante SIP entra a la sala y publica audio en estado "ringing"
 * antes de que la llamada se conteste de verdad — LiveKit no manda el 200 OK
 * al operador hasta que alguien SE SUSCRIBE a su audio (verificado en
 * producción en otro proyecto).
 * Este módulo solo registra QUIÉN llama y a QUÉ sala — no contesta nada.
 * Contestar (dispatchar el agente shadow + dar entrada al navegador de
 * el operador) vive en sdr-console, que es quien de verdad suscribe audio.
 */
import { WebhookReceiver } from 'livekit-server-sdk'
import { createAttioAdapter } from '../crm/attio.js'
import type { CrmAdapter } from '../crm/adapter.js'

export interface PendingCall {
  roomName: string
  phone: string
  leadId?: string
  companyName?: string
  notes?: string
  receivedAt: number
}

// Estado en memoria — un proceso, un usuario, bajo volumen. Si el proceso
// se reinicia a media llamada, se pierde el pending; el ringingTimeout de
// la dispatch rule cuelga esa llamada sola, no se queda huérfana esperando
// para siempre (ver scripts/ensure-inbound-trunk.ts).
const pending = new Map<string, PendingCall>()

export function listPendingCalls(): PendingCall[] {
  return [...pending.values()].sort((a, b) => a.receivedAt - b.receivedAt)
}

// Sin await entre el get y el delete — dentro de un único proceso Node esto
// es atómico frente a dos peticiones "Contestar" casi simultáneas: solo una
// puede ganar el mapa.
export function claimPendingCall(roomName: string): PendingCall | undefined {
  const call = pending.get(roomName)
  if (call) pending.delete(roomName)
  return call
}

export interface LiveKitInboundHandlerOptions {
  apiKey: string
  apiSecret: string
  attioApiKey: string
}

export function createLiveKitInboundHandler(opts: LiveKitInboundHandlerOptions) {
  const receiver = new WebhookReceiver(opts.apiKey, opts.apiSecret)
  let adapter: CrmAdapter | undefined

  return async function handleLiveKitInboundWebhook(
    rawBody: string,
    authHeader: string | undefined,
  ): Promise<void> {
    const event = await receiver.receive(rawBody, authHeader)
    if (event.event !== 'participant_joined') return

    const participant = event.participant
    const roomName = event.room?.name
    const phone = participant?.attributes?.['sip.phoneNumber']
    if (!participant || !roomName || !phone) return // no es un caller SIP

    // Nuestras propias llamadas salientes (dial-script.ts) crean la pata
    // SIP del lead con esta identidad explícita — un caller entrante de
    // verdad la recibe autogenerada por LiveKit, nunca con este prefijo.
    // Sin este filtro, cada llamada que HACEMOS nosotros se registraría
    // aquí como si alguien nos estuviera llamando.
    if (participant.identity?.startsWith('lead-')) return

    adapter ??= await createAttioAdapter(opts.attioApiKey)
    const lead = await adapter.getLeadByPhone(phone).catch(err => {
      console.error('[inbound] fallo buscando lead por teléfono', { phone, err })
      return null
    })

    pending.set(roomName, {
      roomName,
      phone,
      leadId: lead?.id,
      companyName: lead?.display_name,
      notes: lead?.notes,
      receivedAt: Date.now(),
    })
    console.error(
      `[inbound] llamada de ${phone} (${lead?.display_name ?? 'desconocido'}) en sala ${roomName}`,
    )
  }
}
