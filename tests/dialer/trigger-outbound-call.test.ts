/**
 * Cobertura de triggerOutboundCall(lead, opts, mode) — el parámetro `mode`
 * añadido para Modelo B (docs de la conversación: sdr-console + Modelo B).
 * Archivo nuevo y separado de dial-script.test.ts a propósito: ese fichero
 * ya está roto desde antes de esta tarea (importa buildAiCallPayload, que
 * no existe desde la migración a LiveKit) y no es parte de este cambio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Lead } from '../../src/crm/adapter.js'

const createDispatchMock = vi.fn().mockResolvedValue(undefined)
const createSipParticipantMock = vi.fn().mockResolvedValue(undefined)

vi.mock('livekit-server-sdk', () => ({
  AgentDispatchClient: vi.fn().mockImplementation(() => ({
    createDispatch: createDispatchMock,
  })),
  SipClient: vi.fn().mockImplementation(() => ({
    createSipParticipant: createSipParticipantMock,
  })),
}))

const { triggerOutboundCall } = await import('../../src/dialer/dial-script.js')

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead_test',
    status_id: 'stat_pot',
    display_name: 'Test Company',
    contacts: [{ id: 'c1', name: 'Juan', phones: [{ phone: '+34600000001', type: 'mobile' }] }],
    custom: {},
    ...overrides,
  }
}

const opts = {
  livekitUrl: 'wss://example.livekit.cloud',
  livekitApiKey: 'key',
  livekitApiSecret: 'secret',
  sipOutboundTrunkId: 'ST_xxx',
  agentName: 'outbound-agent',
  fromNumber: '+34900000000',
}

describe('triggerOutboundCall — mode metadata (Modelo B)', () => {
  beforeEach(() => {
    createDispatchMock.mockClear()
    createSipParticipantMock.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sin mode explícito, sigue dispatchando mode=voice (comportamiento anterior intacto)', async () => {
    const { roomName } = await triggerOutboundCall(makeLead(), opts)

    expect(roomName).toMatch(/^outbound-lead_test-/)
    expect(createDispatchMock).toHaveBeenCalledTimes(1)
    const [, , dispatchOpts] = createDispatchMock.mock.calls[0] as [string, string, { metadata: string }]
    expect(JSON.parse(dispatchOpts.metadata)).toMatchObject({ mode: 'voice', leadId: 'lead_test' })
  })

  it("mode='shadow' se propaga al metadata del dispatch del agente", async () => {
    await triggerOutboundCall(makeLead(), opts, 'shadow')

    const [, , dispatchOpts] = createDispatchMock.mock.calls[0] as [string, string, { metadata: string }]
    expect(JSON.parse(dispatchOpts.metadata)).toMatchObject({ mode: 'shadow' })
  })

  it('modo shadow sigue marcando solo al lead — ninguna segunda pata SIP', async () => {
    await triggerOutboundCall(makeLead(), opts, 'shadow')

    expect(createSipParticipantMock).toHaveBeenCalledTimes(1)
    const [, , , sipOpts] = createSipParticipantMock.mock.calls[0] as [
      string,
      string,
      string,
      { participantIdentity: string },
    ]
    expect(sipOpts.participantIdentity).toBe('lead-lead_test')
  })
})
