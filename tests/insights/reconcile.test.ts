import { describe, it, expect, vi } from 'vitest'
import { reconcileInsights } from '../../src/insights/reconcile.js'
import type { CrmAdapter, Lead } from '../../src/crm/adapter.js'

function makeMockAdapter(leadCustom: Record<string, unknown> = {}, statusLabel?: string): CrmAdapter {
  return {
    getLeadById: vi.fn().mockResolvedValue({
      id: 'lead_x',
      status_id: 'stat_pot',
      status_label: statusLabel ?? null,
      contacts: [],
      custom: leadCustom,
    } as Lead),
    getLeadByPhone: vi.fn().mockResolvedValue(null),
    updateLead: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue(undefined),
    createLead: vi.fn(),
    getDialableLeads: vi.fn(),
  }
}

function makePayload(overrides: {
  lead_id?: string | null
  to?: string
  results?: Array<{ result: string | Record<string, unknown>; insight_id: string }>
}) {
  return {
    record_type: 'event',
    event_type: 'conversation_insight_result',
    payload: {
      conversation_id: 'conv_abc',
      insight_group_id: 'ig_123',
      results: overrides.results ?? [
        {
          result: { call_outcome: 'interested', call_summary: 'Lead showed interest.' },
          insight_id: 'ins_1',
        },
      ],
      metadata: {
        to: '+34611000000',
        from: '+34900000000',
        telnyx_end_user_target: overrides.to ?? '+34600000001',
        ...(overrides.lead_id !== undefined ? { lead_id: overrides.lead_id ?? undefined } : {}),
      },
    },
  }
}

describe('reconcileInsights', () => {
  it('lead found via metadata.lead_id → updates status + creates note', async () => {
    const adapter = makeMockAdapter()
    await reconcileInsights(makePayload({ lead_id: 'lead_x' }), adapter)
    expect(adapter.getLeadById).toHaveBeenCalledWith('lead_x')
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_x', { statusLabel: 'Interested' })
    expect(adapter.createNote).toHaveBeenCalledWith('lead_x', 'Lead showed interest.')
  })

  it('lead found via metadata.to phone fallback when lead_id absent → updates status', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadByPhone as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_x',
      status_id: 'stat_pot',
      status_label: null,
      contacts: [],
      custom: {},
    } as Lead)
    await reconcileInsights(makePayload({ to: '+34600000001' }), adapter)
    expect(adapter.getLeadByPhone).toHaveBeenCalledWith('+34600000001')  // telnyx_end_user_target
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_x', { statusLabel: 'Interested' })
  })

  it('unknown outcome → no status update', async () => {
    const adapter = makeMockAdapter()
    await reconcileInsights(
      makePayload({
        lead_id: 'lead_x',
        results: [{ result: { call_outcome: 'unknown_outcome', call_summary: null }, insight_id: 'ins_1' }],
      }),
      adapter
    )
    expect(adapter.updateLead).not.toHaveBeenCalled()
  })

  it('terminal status → no status update', async () => {
    const adapter = makeMockAdapter({}, 'Customer')
    await reconcileInsights(makePayload({ lead_id: 'lead_x' }), adapter)
    expect(adapter.updateLead).not.toHaveBeenCalled()
    // note still gets created
    expect(adapter.createNote).toHaveBeenCalledWith('lead_x', 'Lead showed interest.')
  })

  it('no lead found → no crash', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'))
    ;(adapter.getLeadByPhone as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await reconcileInsights(makePayload({ lead_id: 'lead_x', to: '+34600000001' }), adapter)
    expect(adapter.updateLead).not.toHaveBeenCalled()
    expect(adapter.createNote).not.toHaveBeenCalled()
  })
})
