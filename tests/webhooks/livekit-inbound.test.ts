/**
 * Cobertura del filtro "no confundir nuestras propias llamadas salientes
 * con alguien llamándonos" (participant.identity con prefijo 'lead-' —
 * ver src/dialer/dial-script.ts) y de que claimPendingCall es atómico.
 * WebhookReceiver.receive() se mockea: no hay forma de generar una firma
 * real de LiveKit sin credenciales en vivo, y no es lo que se está
 * probando aquí — lo que importa es qué hace el handler con el evento ya
 * verificado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Lead } from '../../src/crm/adapter.js'

const receiveMock = vi.fn()
vi.mock('livekit-server-sdk', () => ({
  WebhookReceiver: vi.fn().mockImplementation(() => ({ receive: receiveMock })),
}))

const getLeadByPhoneMock = vi.fn()
vi.mock('../../src/crm/attio.js', () => ({
  createAttioAdapter: vi.fn().mockResolvedValue({ getLeadByPhone: getLeadByPhoneMock }),
}))

const { createLiveKitInboundHandler, listPendingCalls, claimPendingCall } = await import(
  '../../src/webhooks/livekit-inbound.js'
)

function makeEvent(overrides: {
  event?: string
  roomName?: string
  identity?: string
  phone?: string
}) {
  return {
    event: overrides.event ?? 'participant_joined',
    room: overrides.roomName ? { name: overrides.roomName } : undefined,
    participant: overrides.identity
      ? {
          identity: overrides.identity,
          attributes: overrides.phone ? { 'sip.phoneNumber': overrides.phone } : {},
        }
      : undefined,
  }
}

const opts = { apiKey: 'k', apiSecret: 's', attioApiKey: 'attio_k' }

describe('createLiveKitInboundHandler', () => {
  beforeEach(() => {
    receiveMock.mockReset()
    getLeadByPhoneMock.mockReset()
    // Vacía el estado en memoria entre tests reclamando lo que quede.
    for (const call of listPendingCalls()) claimPendingCall(call.roomName)
  })

  it('ignora nuestras propias llamadas salientes (identity con prefijo lead-)', async () => {
    receiveMock.mockResolvedValue(
      makeEvent({ roomName: 'outbound-abc', identity: 'lead-abc', phone: '+34600000001' }),
    )
    const handle = createLiveKitInboundHandler(opts)

    await handle('{}', 'auth')

    expect(listPendingCalls()).toEqual([])
    expect(getLeadByPhoneMock).not.toHaveBeenCalled()
  })

  it('registra una llamada entrante de verdad, buscando el lead en Attio', async () => {
    const lead: Lead = {
      id: 'lead_1',
      status_id: 'stat',
      display_name: 'Bar Test',
      contacts: [],
      custom: {},
      notes: 'pidió que le llamemos por la tarde',
    }
    getLeadByPhoneMock.mockResolvedValue(lead)
    receiveMock.mockResolvedValue(
      makeEvent({ roomName: 'inbound-xyz', identity: 'sip_random123', phone: '+34611111111' }),
    )
    const handle = createLiveKitInboundHandler(opts)

    await handle('{}', 'auth')

    expect(listPendingCalls()).toEqual([
      expect.objectContaining({
        roomName: 'inbound-xyz',
        phone: '+34611111111',
        leadId: 'lead_1',
        companyName: 'Bar Test',
      }),
    ])
  })

  it('ignora eventos que no son participant_joined', async () => {
    receiveMock.mockResolvedValue(makeEvent({ event: 'room_finished' }))
    const handle = createLiveKitInboundHandler(opts)

    await handle('{}', 'auth')

    expect(listPendingCalls()).toEqual([])
  })

  it('claimPendingCall es atómico — el segundo intento no encuentra nada', async () => {
    getLeadByPhoneMock.mockResolvedValue(null)
    receiveMock.mockResolvedValue(
      makeEvent({ roomName: 'inbound-race', identity: 'sip_r', phone: '+34622222222' }),
    )
    const handle = createLiveKitInboundHandler(opts)
    await handle('{}', 'auth')

    const first = claimPendingCall('inbound-race')
    const second = claimPendingCall('inbound-race')

    expect(first).toMatchObject({ roomName: 'inbound-race' })
    expect(second).toBeUndefined()
  })
})
