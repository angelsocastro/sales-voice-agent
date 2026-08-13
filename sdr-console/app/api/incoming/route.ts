import { NextResponse } from 'next/server'

// Proxy server-side al servidor raíz (src/server.ts, mismo repo, proceso
// aparte) — ahí vive el webhook de LiveKit y el estado en memoria de
// llamadas pendientes (ver src/webhooks/livekit-inbound.ts). sdr-console no
// puede leer esa memoria directamente: son dos procesos Node distintos.
export async function GET() {
  const agentServerUrl = process.env.AGENT_SERVER_URL ?? 'http://localhost:3000'
  try {
    const res = await fetch(`${agentServerUrl}/calls/incoming`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`${res.status}`)
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err) {
    console.error('No se pudo consultar llamadas entrantes', err)
    return NextResponse.json({ calls: [] })
  }
}
