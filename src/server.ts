import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from './config.js'
import { createAttioAdapter } from './crm/attio.js'
import { reconcileInsights, type InsightsPayload } from './insights/reconcile.js'
import { verifyTelnyxSignature } from './webhooks/verify.js'
import { claimPendingCall, createLiveKitInboundHandler, listPendingCalls } from './webhooks/livekit-inbound.js'

async function main() {
  const adapter = await createAttioAdapter(config.ATTIO_API_KEY)

  const app = new Hono()

  app.get('/health', c => c.json({ ok: true }))

  app.post('/webhooks/insights', async c => {
    const rawBody = await c.req.text()
    let payload: InsightsPayload
    try {
      payload = JSON.parse(rawBody) as InsightsPayload
    } catch {
      console.error('[insights] invalid JSON body')
      return c.json({ error: 'Bad Request' }, 400)
    }

    const convId = payload.payload?.conversation_id ?? 'unknown'
    console.error(`[insights] received event_type=${payload.event_type} conversation_id=${convId}`)

    if (config.TELNYX_PUBLIC_KEY) {
      const signature = c.req.header('telnyx-signature-ed25519')
      const timestamp = c.req.header('telnyx-timestamp')
      if (!verifyTelnyxSignature(rawBody, signature, timestamp, config.TELNYX_PUBLIC_KEY)) {
        console.error(`[insights] signature verification failed conversation_id=${convId}`)
        return c.json({ error: 'Unauthorized' }, 401)
      }
      console.error(`[insights] signature OK conversation_id=${convId}`)
    }

    await reconcileInsights(payload, adapter)
    return c.json({ ok: true })
  })

  // Modelo B — llamadas entrantes (ver docs/superpowers de la conversación
  // que introdujo esto y scripts/ensure-inbound-trunk.ts). Registra quién
  // llama; sdr-console decide si/cuándo contestar.
  const handleLiveKitInbound = createLiveKitInboundHandler({
    apiKey: config.LIVEKIT_API_KEY,
    apiSecret: config.LIVEKIT_API_SECRET,
    attioApiKey: config.ATTIO_API_KEY,
  })

  app.post('/webhooks/livekit-inbound', async c => {
    const rawBody = await c.req.text()
    try {
      await handleLiveKitInbound(rawBody, c.req.header('Authorization'))
      return c.json({ ok: true })
    } catch (err) {
      console.error('[inbound] webhook de LiveKit inválido o fallo procesándolo', err)
      return c.json({ error: 'Unauthorized' }, 401)
    }
  })

  // sdr-console sondea esto (vía su propio /api/incoming, proxy server-side)
  // para mostrar el aviso de "llamada entrante" — no hay push todavía, ver
  // conversación de diseño.
  app.get('/calls/incoming', c => {
    return c.json({ calls: listPendingCalls() })
  })

  // Atómico: solo la primera petición para una sala gana. sdr-console llama
  // esto y, si tiene éxito, es quien dispatcha al agente shadow y da el
  // token al operador — este endpoint solo entrega el contexto del lead y
  // libera la sala de la lista de pendientes.
  app.post('/calls/incoming/:room/claim', c => {
    const call = claimPendingCall(c.req.param('room'))
    if (!call) return c.json({ error: 'No hay llamada pendiente en esa sala' }, 404)
    return c.json({ call })
  })

serve({ fetch: app.fetch, port: parseInt(config.PORT, 10) }, info => {
    console.error(`BDR MCP server listening on port ${info.port}`)
  })
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
