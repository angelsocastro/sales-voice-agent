import { NextResponse } from 'next/server'
import { AgentDispatchClient } from 'livekit-server-sdk'

interface PendingCall {
  roomName: string
  phone: string
  leadId?: string
  companyName?: string
  notes?: string
  receivedAt: number
}

// POST — "Contestar". Dos pasos: (1) reclamar la llamada en el servidor
// raíz (atómico, ver src/webhooks/livekit-inbound.ts — solo el primer clic
// gana), (2) dispatchar el agente shadow a la sala que YA existe (la creó
// el inbound trunk al entrar la llamada, no nosotros). No se contesta nada
// aquí explícitamente: en cuanto el navegador del operador (que conecta después
// con el roomName que devolvemos) se suscriba al audio del que llama, ESO
// es lo que hace que la llamada se conteste de verdad — ver
// scripts/ensure-inbound-trunk.ts para el porqué.
export async function POST(_request: Request, context: { params: Promise<{ room: string }> }) {
  const { room } = await context.params
  const agentServerUrl = process.env.AGENT_SERVER_URL ?? 'http://localhost:3000'

  const claimRes = await fetch(`${agentServerUrl}/calls/incoming/${encodeURIComponent(room)}/claim`, {
    method: 'POST',
  })
  if (!claimRes.ok) {
    return NextResponse.json({ error: 'La llamada ya no está disponible' }, { status: 409 })
  }
  const { call } = (await claimRes.json()) as { call: PendingCall }

  const required = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const
  const missing = required.filter(name => !process.env[name])
  if (missing.length > 0) {
    return NextResponse.json({ error: `Faltan variables de entorno: ${missing.join(', ')}` }, { status: 500 })
  }

  const dispatch = new AgentDispatchClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  )
  try {
    await dispatch.createDispatch(call.roomName, process.env.LIVEKIT_AGENT_NAME ?? 'outbound-agent', {
      metadata: JSON.stringify({
        leadId: call.leadId ?? '',
        companyName: call.companyName ?? '',
        phone: call.phone,
        notes: call.notes ?? '',
        mode: 'shadow',
      }),
    })
  } catch (err) {
    console.error('Fallo al dispatchar el agente shadow para la llamada entrante', { room, err })
    return NextResponse.json({ error: 'No se pudo entrar a la llamada' }, { status: 500 })
  }

  return NextResponse.json({
    roomName: call.roomName,
    leadName: call.companyName || call.phone,
  })
}
