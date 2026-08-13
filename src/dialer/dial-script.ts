import { toZonedTime } from 'date-fns-tz'
import { getDay, getHours, getMinutes } from 'date-fns'
import { AgentDispatchClient, SipClient } from 'livekit-server-sdk'
import { randomUUID } from 'node:crypto'
import type { CrmAdapter, Lead } from '../crm/adapter.js'

const TZ = 'Europe/Madrid'
const MAX_RETRIES = 3
const MIN_HOURS_BETWEEN = 3
const MAX_CONCURRENT = 3

// Call windows: Mon–Fri 09:00–14:00 and 16:00–19:00 Madrid
export function isCallableNow(now: Date = new Date()): boolean {
  const madrid = toZonedTime(now, TZ)
  const day = getDay(madrid)   // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false

  const h = getHours(madrid)
  const m = getMinutes(madrid)
  const timeInMinutes = h * 60 + m

  const morning = timeInMinutes >= 9 * 60 && timeInMinutes < 14 * 60
  const afternoon = timeInMinutes >= 16 * 60 && timeInMinutes < 19 * 60

  return morning || afternoon
}

export interface DialOptions {
  livekitUrl: string
  livekitApiKey: string
  livekitApiSecret: string
  sipOutboundTrunkId: string
  agentName: string
  fromNumber: string
}

// El agente LiveKit lee este JSON de `job.metadata` (ver main.ts en
// livekit-agent) para saber a quién está llamando — reemplaza el `Variables`
// que antes mandaba la API de AI Assistant de Telnyx.
export interface LeadJobMetadata {
  leadId: string
  companyName: string
  phone: string
  notes: string
}

// 'voice' (default): el agente habla por TTS, como hoy. 'shadow' (Modelo B):
// el agente no habla — sugiere por texto a un dashboard mientras un humano
// habla de verdad por WebRTC (ver livekit-agent/src/main.ts).
export type CallMode = 'voice' | 'shadow'

export function buildLeadJobMetadata(lead: Lead): { phone: string; metadata: LeadJobMetadata } {
  const phone = lead.contacts
    .flatMap(c => c.phones)
    .find(p => p.phone)

  if (!phone) throw new Error(`Lead ${lead.id} has no phone`)

  return {
    phone: phone.phone,
    metadata: {
      leadId: lead.id,
      companyName: lead.display_name ?? '',
      phone: phone.phone,
      notes: lead.notes ?? '',
    },
  }
}

// Dispatcha el agente ANTES de marcar, para que ya esté en la room lista
// para hablar en cuanto el lead descuelgue — si se marca primero, el saludo
// inicial puede perderse mientras el worker arranca. `mode` por defecto
// 'voice' — llamarla sin tercer argumento (como hace runDialer/el batch de
// abajo) se comporta exactamente igual que antes de Modelo B. Devuelve
// roomName porque el flujo asistido (sdr-console/app/api/dial/route.ts) lo necesita
// para dar de alta al humano en la misma sala desde el dashboard.
export async function triggerOutboundCall(
  lead: Lead,
  opts: DialOptions,
  mode: CallMode = 'voice',
): Promise<{ roomName: string }> {
  const { phone, metadata } = buildLeadJobMetadata(lead)
  const roomName = `outbound-${lead.id}-${randomUUID()}`

  const agentDispatch = new AgentDispatchClient(opts.livekitUrl, opts.livekitApiKey, opts.livekitApiSecret)
  await agentDispatch.createDispatch(roomName, opts.agentName, {
    metadata: JSON.stringify({ ...metadata, mode }),
  })

  const sip = new SipClient(opts.livekitUrl, opts.livekitApiKey, opts.livekitApiSecret)
  await sip.createSipParticipant(opts.sipOutboundTrunkId, phone, roomName, {
    fromNumber: opts.fromNumber,
    participantIdentity: `lead-${lead.id}`,
    participantName: lead.display_name ?? undefined,
    playDialtone: true,
    waitUntilAnswered: false,
  })

  return { roomName }
}

export async function runDialer(): Promise<void> {
  // Lazy import config so module can be imported in tests without env vars
  const { config } = await import('../config.js')
  const { createAttioAdapter } = await import('../crm/attio.js')

  if (!isCallableNow()) {
    console.error('Outside calling window — skipping dial run.')
    return
  }

  const adapter = await createAttioAdapter(config.ATTIO_API_KEY)
  const leads = await adapter.getDialableLeads(MAX_RETRIES, MIN_HOURS_BETWEEN)

  if (leads.length === 0) {
    console.error('No dialable leads found.')
    return
  }

  console.error(`Dialing ${leads.length} leads (concurrency: ${MAX_CONCURRENT})`)

  const opts: DialOptions = {
    livekitUrl: config.LIVEKIT_URL,
    livekitApiKey: config.LIVEKIT_API_KEY,
    livekitApiSecret: config.LIVEKIT_API_SECRET,
    sipOutboundTrunkId: config.LIVEKIT_SIP_OUTBOUND_TRUNK_ID,
    agentName: config.LIVEKIT_AGENT_NAME,
    fromNumber: config.TELNYX_FROM_NUMBER,
  }

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < leads.length; i += MAX_CONCURRENT) {
    const batch = leads.slice(i, i + MAX_CONCURRENT)
    await Promise.allSettled(
      batch.map(async lead => {
        try {
          await triggerOutboundCall(lead, opts)
          console.error(`Called lead ${lead.id} (${lead.display_name})`)
        } catch (err) {
          console.error(`Failed to call lead ${lead.id}:`, err)
        }
      })
    )
  }
}

// CLI entry point
if (process.argv[1]?.endsWith('dial-script.ts') || process.argv[1]?.endsWith('dial-script.js')) {
  runDialer().catch(err => {
    console.error('Dialer error:', err)
    process.exit(1)
  })
}
