import { NextRequest, NextResponse } from 'next/server'
import { getRoomServiceClient } from '../../../lib/livekit-server'

// POST /api/hangup { room } — el único sitio que de verdad cuelga. Que el
// operador se desconecte del navegador NO basta: dejaría al lead en una sala con el
// agente shadow mudo y nadie con quien hablar. Esto borra la sala entera,
// que corta también la pata SIP del lead (mismo mecanismo que el timeout de
// MAX_CALL_DURATION en livekit-agent/src/main.ts).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const room = typeof body.room === 'string' ? body.room : undefined
  if (!room) {
    return NextResponse.json({ error: 'Falta room en el body' }, { status: 400 })
  }

  try {
    await getRoomServiceClient().deleteRoom(room)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Fallo al colgar', { room, err })
    return NextResponse.json({ error: 'No se pudo colgar' }, { status: 500 })
  }
}
