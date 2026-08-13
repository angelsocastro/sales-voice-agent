/**
 * Guardas de configuración — no llaman a ningún modelo, solo construyen la
 * sesión y comprueban cómo queda resuelta.
 *
 * El test que importa de verdad es el de unidades: los delays del SDK de Node
 * son MILISEGUNDOS y en la migración desde el agente Python (donde son
 * SEGUNDOS) se copiaron los valores tal cual, dejando el agente sin ninguna
 * tolerancia a pausas ni protección contra el ruido. Es un bug invisible —
 * compila, arranca y solo se nota oyendo llamadas reales — así que se fija aquí.
 */

import { initializeLogger, type voice } from '@livekit/agents'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildKeyterms,
  buildSystemPrompt,
  createSession,
  ENDPOINTING_OPTIONS,
  INTERRUPTION_OPTIONS,
  PREEMPTIVE_GENERATION_OPTIONS,
  TEST_LEAD_CONTEXT,
  VAD_OPTIONS,
  type LeadContext,
} from '../src/agent.js'

const LEAD: LeadContext = {
  leadId: 'lead-123',
  companyName: 'Distribuciones López',
  phone: '+34600000000',
  notes: 'Preguntar por María',
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'error' })
  // Construir inference.STT/TTS exige credenciales; no se hace ninguna llamada
  // de red al construir la sesión.
  process.env.LIVEKIT_URL ??= 'wss://test.livekit.cloud'
  process.env.LIVEKIT_API_KEY ??= 'APItest'
  process.env.LIVEKIT_API_SECRET ??= 'secret'
  process.env.TELNYX_API_KEY ??= 'KEYtest'
})

describe('turn handling', () => {
  it('usa milisegundos, no segundos (regresión del port desde Python)', () => {
    // Un valor por debajo de 50 solo puede ser un número pensado en segundos:
    // 0.3s escrito como 0.3 son 0.3ms, es decir, sin espera ninguna.
    expect(ENDPOINTING_OPTIONS.minDelay).toBeGreaterThanOrEqual(100)
    expect(ENDPOINTING_OPTIONS.maxDelay).toBeGreaterThanOrEqual(1000)
    expect(ENDPOINTING_OPTIONS.maxDelay).toBeGreaterThan(ENDPOINTING_OPTIONS.minDelay)
    expect(INTERRUPTION_OPTIONS.minDuration).toBeGreaterThanOrEqual(200)
    expect(INTERRUPTION_OPTIONS.falseInterruptionTimeout).toBeGreaterThanOrEqual(500)
    expect(VAD_OPTIONS.minSpeechDuration).toBeGreaterThanOrEqual(50)
    expect(VAD_OPTIONS.minSilenceDuration).toBeGreaterThanOrEqual(200)
  })

  it('la sesión aplica endpointing, interrupción y generación preemptiva', () => {
    const session = createSession(LEAD) as voice.AgentSession
    const turnHandling = session.sessionOptions.turnHandling

    expect(turnHandling.endpointing.minDelay).toBe(ENDPOINTING_OPTIONS.minDelay)
    expect(turnHandling.endpointing.maxDelay).toBe(ENDPOINTING_OPTIONS.maxDelay)
    expect(turnHandling.interruption.minDuration).toBe(INTERRUPTION_OPTIONS.minDuration)
    // Exigir una palabra reconocida antes de callar al agente: sin esto, el
    // ruido de una nave o un bar lo corta a mitad de frase.
    expect(turnHandling.interruption.minWords).toBeGreaterThanOrEqual(1)
    expect(turnHandling.preemptiveGeneration.enabled).toBe(true)
    expect(turnHandling.preemptiveGeneration.preemptiveTts).toBe(
      PREEMPTIVE_GENERATION_OPTIONS.preemptiveTts,
    )
  })

  it('sesga el STT con los keyterms del lead', () => {
    const session = createSession(LEAD) as voice.AgentSession
    expect(session.keyterms).toContain(LEAD.companyName)
  })
})

describe('keyterms', () => {
  it('incluye el nombre de la empresa cuando es utilizable', () => {
    expect(buildKeyterms(LEAD)).toContain('Distribuciones López')
  })

  it('descarta el placeholder del lead de test y los nombres vacíos', () => {
    expect(buildKeyterms(TEST_LEAD_CONTEXT)).not.toContain(TEST_LEAD_CONTEXT.companyName)
    expect(buildKeyterms({ ...LEAD, companyName: '  ' })).toEqual(buildKeyterms(TEST_LEAD_CONTEXT))
  })
})

describe('system prompt', () => {
  it('mantiene el contexto del lead', () => {
    const prompt = buildSystemPrompt(LEAD)
    expect(prompt).toContain('Distribuciones López')
    expect(prompt).toContain('Preguntar por María')
  })

  it('deja el bloque variable al final para que el prefijo sea cacheable', () => {
    const marker = '# Contexto de esta llamada'
    const a = buildSystemPrompt(LEAD)
    const b = buildSystemPrompt({ ...LEAD, leadId: 'otro', companyName: 'Bebidas Ruiz', notes: '' })

    expect(a.indexOf(marker)).toBeGreaterThan(0)
    // Todo lo anterior al bloque del lead tiene que ser idéntico entre llamadas:
    // es lo que permite al proveedor reutilizar el prefijo ya prefillado. La
    // proporción real depende del tamaño del template inyectado (ver
    // prompt-config.ts) — con un template de negocio grande, ese prefijo
    // compartido es casi todo el prompt.
    expect(a.slice(0, a.indexOf(marker))).toBe(b.slice(0, b.indexOf(marker)))
  })
})
