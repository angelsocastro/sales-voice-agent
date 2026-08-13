/**
 * Escritura de resultado en Attio, con `fetch` mockeado — sin red.
 *
 * Cubre sobre todo el resultado nuevo `buzon_voz` (lo produce la detección de
 * contestador de main.ts, no el LLM): tiene que contar como intento y
 * reprogramar el reintento, no marcar el lead como trabajado ni descartarlo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordCallOutcome } from '../src/crm-outcome.js'

const API_KEY = 'api_test'
const LEAD_ID = 'rec_123'

interface Captured {
  method: string
  url: string
  body: any
}

let calls: Captured[]

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      })
      if ((init.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ data: { values: { call_attempts: [{ value: 2 }] } } }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const patchBody = () => calls.find(c => c.method === 'PATCH')?.body.data.values

describe('recordCallOutcome', () => {
  it('buzon_voz cuenta como intento y reprograma el reintento', async () => {
    await recordCallOutcome(API_KEY, {
      leadId: LEAD_ID,
      outcome: 'buzon_voz',
      resumen: 'Saltó el contestador.',
    })

    const values = patchBody()
    expect(values.status).toBe('Called')
    expect(values.call_attempts).toBe(3)
    expect(typeof values.next_attempt).toBe('string')
    // No se saca del auto-dialer ni se bloquea: el lead sigue siendo llamable.
    expect(values.managed_by).toBeUndefined()
    expect(calls.some(c => c.url.endsWith('/tasks'))).toBe(false)
    expect(calls.some(c => c.url.endsWith('/notes'))).toBe(true)
  })

  it('opt_out bloquea el lead para siempre', async () => {
    await recordCallOutcome(API_KEY, {
      leadId: LEAD_ID,
      outcome: 'opt_out',
      resumen: 'Pidió no ser llamado más.',
    })

    const values = patchBody()
    expect(values.status).toBe('Not Interested')
    expect(values.call_attempts).toBeGreaterThan(100)
    expect(values.next_attempt).toBeUndefined()
  })

  it('piloto_agendado pasa el lead al operador y crea la tarea', async () => {
    await recordCallOutcome(API_KEY, {
      leadId: LEAD_ID,
      outcome: 'piloto_agendado',
      resumen: 'Dolor confirmado, productos recogidos.',
      nextAttemptISO: '2026-08-06T10:00:00.000Z',
      taskText: 'El operador llama con el piloto montado',
    })

    const values = patchBody()
    expect(values.status).toBe('Interested')
    expect(values.managed_by).toBe('closer')
    expect(calls.some(c => c.url.endsWith('/tasks'))).toBe(true)
  })
})
