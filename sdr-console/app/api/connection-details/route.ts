import { NextRequest, NextResponse } from 'next/server'
import { getLiveKitUrl, mintDashboardToken } from '../../../lib/livekit-server'

// GET /api/connection-details?room=<roomName> — la sala ya existe (la creó
// /api/dial al marcar); aquí solo se emite el token del operador para esa sala
// concreta. A diferencia del ejemplo genérico de LiveKit, esto NUNCA genera
// un roomName nuevo — unirse a la sala equivocada significaría no oír al lead.
export async function GET(request: NextRequest) {
  const room = request.nextUrl.searchParams.get('room')
  if (!room) {
    return NextResponse.json({ error: 'Falta el parámetro room' }, { status: 400 })
  }

  try {
    const token = await mintDashboardToken(room)
    return NextResponse.json({ serverUrl: getLiveKitUrl(), token, room })
  } catch (err) {
    console.error('No se pudo generar el token del dashboard', err)
    return NextResponse.json({ error: 'Error de configuración del servidor' }, { status: 500 })
  }
}
