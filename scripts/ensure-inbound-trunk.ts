#!/usr/bin/env npx tsx
/**
 * Aprovisiona la infraestructura de LLAMADAS ENTRANTES (Modelo B — inbound):
 * una FQDN connection de Telnyx que reenvía hacia LiveKit, un inbound trunk
 * de LiveKit (catch-all, autenticado por IP allowlist), y una dispatch rule
 * `individual` SIN `roomConfig.agents` — nada se despacha automáticamente al
 * entrar la llamada; main.ts/webhook deciden qué pasa (mecanismo ya
 * verificado en producción en otro proyecto:
 * un participante SIP entra a la sala y publica audio en estado "ringing"
 * ANTES de que la llamada se conteste de verdad — LiveKit no manda el 200 OK
 * al operador hasta que alguien SE SUSCRIBE a su audio. Eso es lo que hace
 * que "no contestamos hasta que responde alguien" funcione sin Telnyx Call
 * Control: no hace falta un comando de "answer" en ningún sitio, es
 * consecuencia de que el dashboard o el agente shadow se suscriban).
 *
 * Es un PUERTO deliberadamente reducido de un script equivalente de otro
 * proyecto — misma receta verificada en
 * producción (incluye dos bugs reales ya resueltos allí: 407 si el trunk
 * lleva authUsername/authPassword A LA VEZ que allowedAddresses — Telnyx
 * nunca presenta credenciales en esta pata, solo IP; y 422 "Microsoft Teams
 * SBC" si se setea outbound.ip_authentication_method explícito en la FQDN
 * connection). NO se copia nada de: split dev/prod (outbound-agent es un
 * solo entorno), Messaging Profile/SMS (no aplica aquí), ni el outbound
 * trunk existente (LIVEKIT_SIP_OUTBOUND_TRUNK_ID ya funciona, no se toca —
 * esta es una FQDN connection nueva y separada, solo para inbound).
 *
 * Uso:
 *   npx tsx scripts/ensure-inbound-trunk.ts
 *
 * Antes de correrlo:
 * 1. LIVEKIT_SIP_AUTH_USERNAME/LIVEKIT_SIP_AUTH_PASSWORD en .env — un
 *    secreto cualquiera que tú fijas una vez (ej. `openssl rand -hex 32`),
 *    no lo genera el script.
 * 2. LIVEKIT_SIP_SUBDOMAIN en .env — el subdominio SIP de tu proyecto
 *    LiveKit Cloud (dashboard → Settings → SIP, algo tipo "xxxxxxxxx", sin
 *    ".sip.livekit.cloud"). Es específico de tu proyecto, no lo puedo
 *    adivinar.
 *
 * Después de correrlo:
 * - Copia el número/DID que quieras usar para inbound al dashboard de
 *   Telnyx, asociado a la FQDN connection que imprime este script
 *   (`outbound-agent-livekit-inbound`) — eso sí se hace a mano en su
 *   dashboard, el script no conoce números de teléfono.
 * - No hace falta guardar ningún ID que imprima este script en .env — la
 *   dispatch rule y el inbound trunk quedan registrados en LiveKit por
 *   nombre; el runtime (webhook) no necesita conocer sus IDs.
 */
import { SipClient } from 'livekit-server-sdk'

const DISPATCH_RULE_NAME = 'outbound-agent-inbound'
const INBOUND_TRUNK_NAME = 'outbound-agent-livekit-inbound'
const FQDN_CONNECTION_NAME = 'outbound-agent-livekit-inbound'
const TELNYX_API_BASE = 'https://api.telnyx.com/v2'

// Mismo allowlist que en otro proyecto propio
// (verificado contra sip.telnyx.com 2026-07-22) — Telnyx "continuously
// expands its network" según su propia doc, revalidar periódicamente,
// no tratar como fijo para siempre.
const TELNYX_SIP_SIGNALING_IPS = [
  '185.246.41.140/32', // Telnyx Europe
  '185.246.41.141/32', // Telnyx Europe
]

// Mismo motivo que en otro proyecto propio: Telnyx solo whitelist-ea US/CA por defecto en
// el outbound voice profile — sin esto, cualquier llamada saliente en la
// pata de esta conexión (necesaria para el handshake SIP aunque el uso
// primario sea inbound) a España 403 con permission_denied.
const OUTBOUND_WHITELISTED_DESTINATIONS = ['ES', 'PT', 'FR', 'IT', 'DE', 'GB', 'AD', 'US', 'CA']

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Falta ${name} en el entorno`)
    process.exit(1)
  }
  return value
}

async function telnyxRequest(apiKey: string, path: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`${TELNYX_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`Telnyx ${method} ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function ensureOutboundVoiceProfile(telnyxApiKey: string): Promise<string> {
  const name = FQDN_CONNECTION_NAME
  const existing = await telnyxRequest(telnyxApiKey, `/outbound_voice_profiles?filter[name]=${encodeURIComponent(name)}`)
  const already = existing.data.find((p: any) => p.name === name)
  if (already) {
    await telnyxRequest(telnyxApiKey, `/outbound_voice_profiles/${already.id}`, 'PATCH', {
      whitelisted_destinations: OUTBOUND_WHITELISTED_DESTINATIONS,
    })
    console.log(`[outbound-voice-profile] ya existe, whitelist reconciliada: ${already.id}`)
    return already.id
  }
  const created = await telnyxRequest(telnyxApiKey, '/outbound_voice_profiles', 'POST', {
    name,
    traffic_type: 'conversational',
    service_plan: 'global',
    whitelisted_destinations: OUTBOUND_WHITELISTED_DESTINATIONS,
  })
  console.log(`[outbound-voice-profile] creado: ${created.data.id}`)
  return created.data.id
}

// Payload calcado del quickstart oficial LiveKit×Telnyx — outbound.ip_authentication_method
// NUNCA se setea explícito (dispara un 422 "Microsoft Teams SBC" en validación, confirmado
// en vivo en otro proyecto). La auth sale de user_name/password de nivel superior + el profile.
async function ensureTelnyxFqdnConnection(telnyxApiKey: string, sipUsername: string, sipPassword: string): Promise<string> {
  const voiceProfileId = await ensureOutboundVoiceProfile(telnyxApiKey)
  const existing = await telnyxRequest(
    telnyxApiKey,
    `/fqdn_connections?filter[connection_name]=${encodeURIComponent(FQDN_CONNECTION_NAME)}`,
  )
  const already = existing.data.find((c: any) => c.connection_name === FQDN_CONNECTION_NAME)
  if (already) {
    await telnyxRequest(telnyxApiKey, `/fqdn_connections/${already.id}`, 'PATCH', {
      user_name: sipUsername,
      password: sipPassword,
      outbound: { outbound_voice_profile_id: voiceProfileId },
    })
    console.log(`[telnyx-fqdn-connection] ya existe, auth reconciliada: ${already.id}`)
    return already.id
  }
  const created = await telnyxRequest(telnyxApiKey, '/fqdn_connections', 'POST', {
    active: true,
    anchorsite_override: 'Latency',
    connection_name: FQDN_CONNECTION_NAME,
    user_name: sipUsername,
    password: sipPassword,
    inbound: { ani_number_format: '+E.164', dnis_number_format: '+e164' },
    outbound: { outbound_voice_profile_id: voiceProfileId },
    transport_protocol: 'TCP',
  })
  console.log(`[telnyx-fqdn-connection] creada: ${created.data.id}`)
  return created.data.id
}

async function ensureFqdn(telnyxApiKey: string, connectionId: string, fqdn: string): Promise<string> {
  const existing = await telnyxRequest(
    telnyxApiKey,
    `/fqdns?filter[connection_id]=${encodeURIComponent(connectionId)}&filter[fqdn]=${encodeURIComponent(fqdn)}`,
  )
  const already = existing.data.find((f: any) => f.fqdn === fqdn)
  if (already) {
    console.log(`[telnyx-fqdn] ya existe: ${fqdn} (${already.id})`)
    return already.id
  }
  const created = await telnyxRequest(telnyxApiKey, '/fqdns', 'POST', { connection_id: connectionId, fqdn, port: 5060 })
  console.log(`[telnyx-fqdn] creado: ${fqdn} (${created.data.id})`)
  return created.data.id
}

async function ensureFqdnRouting(telnyxApiKey: string, connectionId: string, sipSubdomain: string): Promise<void> {
  const fqdn = `${sipSubdomain}.sip.livekit.cloud`
  const fqdnId = await ensureFqdn(telnyxApiKey, connectionId, fqdn)
  await telnyxRequest(telnyxApiKey, `/fqdn_connections/${connectionId}`, 'PATCH', {
    inbound: { default_primary_fqdn_id: fqdnId, default_secondary_fqdn_id: null, default_routing_method: null },
  })
  console.log(`[telnyx-fqdn-routing] primario=${fqdn}`)
}

async function ensureInboundTrunk(client: SipClient): Promise<string> {
  const existing = await client.listSipInboundTrunk()
  const already = existing.find(t => t.name === INBOUND_TRUNK_NAME)
  if (already) {
    // authUsername/authPassword fuerza digest auth en cada llamada entrante,
    // pase lo que pase con allowedAddresses — la pata de reenvío de Telnyx
    // (FQDN connection) nunca presenta credenciales, así que un trunk con
    // esto puesto se queda atascado en 407 para siempre. Confirmado en vivo
    // en otro proyecto.
    await client.updateSipInboundTrunkFields(already.sipTrunkId, {
      allowedAddresses: { set: TELNYX_SIP_SIGNALING_IPS },
      authUsername: '',
      authPassword: '',
    })
    console.log(`[inbound-trunk] ya existe, allowlist reconciliada: ${already.sipTrunkId}`)
    return already.sipTrunkId
  }
  const created = await client.createSipInboundTrunk(INBOUND_TRUNK_NAME, [], {
    allowedAddresses: TELNYX_SIP_SIGNALING_IPS,
  })
  console.log(`[inbound-trunk] creado: ${created.sipTrunkId}`)
  return created.sipTrunkId
}

async function ensureDispatchRule(client: SipClient, inboundTrunkId: string): Promise<void> {
  const existing = await client.listSipDispatchRule()
  const already = existing.find(r => r.name === DISPATCH_RULE_NAME)
  if (already) {
    console.log(`[dispatch-rule] ya existe: ${already.sipDispatchRuleId} (trunks: ${already.trunkIds.join(', ')})`)
    return
  }
  // roomPrefix: "" — sin costura de prefijo que capturar a mano (lección
  // aprendida en una iteración anterior). SIN roomConfig.agents:
  // nada se despacha automáticamente — main.ts/webhook deciden.
  const rule = await client.createSipDispatchRule(
    { type: 'individual', roomPrefix: '' },
    { name: DISPATCH_RULE_NAME, trunkIds: [inboundTrunkId] },
  )
  console.log(`[dispatch-rule] creada: ${rule.sipDispatchRuleId}`)
}

async function main() {
  const livekitUrl = requireEnv('LIVEKIT_URL')
  const apiKey = requireEnv('LIVEKIT_API_KEY')
  const apiSecret = requireEnv('LIVEKIT_API_SECRET')
  const telnyxApiKey = requireEnv('TELNYX_API_KEY')
  const sipUsername = requireEnv('LIVEKIT_SIP_AUTH_USERNAME')
  const sipPassword = requireEnv('LIVEKIT_SIP_AUTH_PASSWORD')
  const sipSubdomain = requireEnv('LIVEKIT_SIP_SUBDOMAIN')

  const client = new SipClient(livekitUrl, apiKey, apiSecret)

  const connectionId = await ensureTelnyxFqdnConnection(telnyxApiKey, sipUsername, sipPassword)
  await ensureFqdnRouting(telnyxApiKey, connectionId, sipSubdomain)
  const inboundTrunkId = await ensureInboundTrunk(client)
  await ensureDispatchRule(client, inboundTrunkId)

  console.log(`\nListo. En el dashboard de Telnyx, asocia el número que quieras usar para` )
  console.log(`llamadas entrantes a la FQDN connection "${FQDN_CONNECTION_NAME}" (id ${connectionId}).`)
}

main().catch(err => {
  console.error('Fallo aprovisionando el inbound trunk:', err)
  process.exit(1)
})
