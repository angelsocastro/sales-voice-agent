// Solo servidor — nunca importar desde un Client Component. Lee las mismas
// LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET que ya usa el resto del
// repo (dial-script.ts / livekit-agent) para marcar y para dispatchar al
// agente shadow — este dashboard no crea infraestructura nueva, solo se
// une a la sala que /api/dial ya montó.
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Falta ${name} en el entorno de sdr-console`)
  return value
}

export function getLiveKitUrl(): string {
  return requireEnv('LIVEKIT_URL')
}

// identity fija por sala (no por sesión de navegador): si el operador
// recarga la pestaña a mitad de llamada, vuelve a entrar como el mismo
// participante en vez de dejar un fantasma desconectado ocupando la sala.
export async function mintDashboardToken(roomName: string): Promise<string> {
  const at = new AccessToken(requireEnv('LIVEKIT_API_KEY'), requireEnv('LIVEKIT_API_SECRET'), {
    identity: 'operator',
    name: 'Operador',
    ttl: '4h',
  })
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  })
  return at.toJwt()
}

export function getRoomServiceClient(): RoomServiceClient {
  return new RoomServiceClient(getLiveKitUrl(), requireEnv('LIVEKIT_API_KEY'), requireEnv('LIVEKIT_API_SECRET'))
}
