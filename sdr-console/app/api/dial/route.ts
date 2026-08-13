import { NextRequest, NextResponse } from 'next/server'
import { createAttioAdapter } from '../../../../src/crm/attio'
import { triggerOutboundCall, type CallMode, type DialOptions } from '../../../../src/dialer/dial-script'

// POST { leadId, mode? } — la sala/lead se marcan exactamente igual que en
// runDialer()/scripts/call.ts (triggerOutboundCall sin tocar), pero
// disparado desde la cola del propio dashboard (app/page.tsx) en vez de una
// terminal aparte. Devuelve roomName para que el cliente navegue directo a
// /call/[room] — sin URL que copiar ni pegar.
//
// mode por defecto 'shadow' (Modelo B, el operador habla) — 'voice' es el modo IA
// completo (el agente habla solo, con TTS) que ya existía antes de Modelo B;
// se deja disponible como toggle para poder comparar humano vs IA a
// propósito, no porque vaya a ser el modo normal de trabajo.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const leadId = typeof body.leadId === 'string' ? body.leadId : undefined
  if (!leadId) {
    return NextResponse.json({ error: 'Falta leadId' }, { status: 400 })
  }
  const mode: CallMode = body.mode === 'voice' ? 'voice' : 'shadow'

  const required = [
    'ATTIO_API_KEY',
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_SIP_OUTBOUND_TRUNK_ID',
  ] as const
  const missing = required.filter(name => !process.env[name])
  if (missing.length > 0) {
    return NextResponse.json({ error: `Faltan variables de entorno: ${missing.join(', ')}` }, { status: 500 })
  }

  const adapter = await createAttioAdapter(process.env.ATTIO_API_KEY!)
  const lead = await adapter.getLeadById(leadId)
  if (!lead) {
    return NextResponse.json({ error: 'Lead no encontrado' }, { status: 404 })
  }

  const opts: DialOptions = {
    livekitUrl: process.env.LIVEKIT_URL!,
    livekitApiKey: process.env.LIVEKIT_API_KEY!,
    livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
    sipOutboundTrunkId: process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID!,
    agentName: process.env.LIVEKIT_AGENT_NAME ?? 'outbound-agent',
    fromNumber: process.env.TELNYX_FROM_NUMBER ?? '',
  }

  try {
    const { roomName } = await triggerOutboundCall(lead, opts, mode)
    return NextResponse.json({ roomName, leadName: lead.display_name ?? lead.id, mode })
  } catch (err) {
    console.error('Fallo al marcar', { leadId, err })
    return NextResponse.json({ error: 'No se pudo marcar' }, { status: 500 })
  }
}
