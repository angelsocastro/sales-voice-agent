/**
 * Cobertura del nuevo opts.skipShutdown (Modelo B) — a diferencia de tests de
 * comportamiento en vivo del prompt real (fuera de este repo, ver
 * prompt-config.ts), esto no necesita LIVEKIT_API_KEY ni un juez LLM en vivo:
 * llama a tool.execute(...) directamente con fetch mockeado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCallOutcomeRecorder, createEndCallTool } from '../src/agent.js'
import type { LeadContext } from '../src/agent.js'

const lead: LeadContext = {
  leadId: 'lead_test',
  companyName: 'Bar Test',
  phone: '+34600000000',
  notes: '',
}

// ctx sin .session/.speechHandle a propósito: si el código de skipShutdown
// alguna vez volviera a tocar esas rutas por error, esto lanzaría
// TypeError en vez de pasar la prueba en silencio.
const bareToolOptions = {
  ctx: {} as never,
  toolCallId: 'call_1',
  abortSignal: new AbortController().signal,
}

describe('createEndCallTool — skipShutdown (Modelo B)', () => {
  beforeEach(() => {
    process.env.ATTIO_API_KEY = 'test_key'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { values: {} } }),
        text: async () => '',
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.ATTIO_API_KEY
  })

  it('escribe en Attio pero nunca toca ctx.session/ctx.speechHandle', async () => {
    const tool = createEndCallTool(createCallOutcomeRecorder(lead), { skipShutdown: true })

    const result = await tool.execute(
      { resultado: 'descalificado', resumen: 'Sin dolor en ningún ángulo.' },
      bareToolOptions,
    )

    expect(result).toContain('No cierres')
    // recordCallOutcome dispara sus escrituras en fire-and-forget (.catch),
    // así que dejamos pasar un tick antes de comprobar fetch.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).toHaveBeenCalled()
  })

  it('sin skipShutdown, el mensaje de vuelta sigue pidiendo despedida (comportamiento sin tocar)', async () => {
    const tool = createEndCallTool(createCallOutcomeRecorder(lead), { skipShutdown: false })

    // Aquí SÍ tocaría ctx.session — probamos solo que la rama sigue viva
    // (no lanza al construir el tool) sin ejecutar execute(), que exigiría
    // mockear AgentSession entero; eso se cubre con tests de comportamiento
    // en vivo del prompt real, fuera de este repo.
    expect(tool.description).not.toContain('NO cuelga')
  })
})
