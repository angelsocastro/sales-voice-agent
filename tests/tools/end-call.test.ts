import { describe, it, expect, vi } from 'vitest'
import { endCallTool } from '../../src/tools/end-call.js'
import type { CrmAdapter } from '../../src/crm/adapter.js'

function makeMockAdapter(): CrmAdapter {
  return {
    getLeadById: vi.fn(),
    getLeadByPhone: vi.fn(),
    updateLead: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(undefined),
    createNote: vi.fn().mockResolvedValue(undefined),
    createLead: vi.fn(),
    getDialableLeads: vi.fn(),
  }
}

describe('endCallTool', () => {
  it('maps resultado=interesado → status Interesado', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_e', status_id: 'stat_pot', contacts: [],
      custom: {},
    })
    const tool = endCallTool(adapter)
    await tool.handler({
      lead_id: 'lead_e',
      resultado: 'interesado',
      transcript: 'Le interesa el software de cobros.',
    }, {})
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_e', expect.objectContaining({
      statusLabel: 'Interested',
    }))
    expect(adapter.createNote).toHaveBeenCalledWith('lead_e', expect.stringContaining('Le interesa'))
  })

  it('maps resultado=contacto_malo → status Bad Fit', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_e', status_id: 'stat_pot', contacts: [],
      custom: {},
    })
    const tool = endCallTool(adapter)
    await tool.handler({ lead_id: 'lead_e', resultado: 'contacto_malo', transcript: '' }, {})
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_e', expect.objectContaining({
      statusLabel: 'Bad Fit',
    }))
  })

  it('maps resultado=no_icp → status No interesado', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_e', status_id: 'stat_pot', contacts: [],
      custom: {},
    })
    const tool = endCallTool(adapter)
    await tool.handler({ lead_id: 'lead_e', resultado: 'no_icp', transcript: '' }, {})
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_e', expect.objectContaining({
      statusLabel: 'Not Interested',
    }))
  })

  it('sets managed_by=closer on handoff', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_e', status_id: 'stat_pot', contacts: [],
      custom: {},
    })
    const tool = endCallTool(adapter)
    await tool.handler({ lead_id: 'lead_e', resultado: 'handoff', transcript: 'Pasan a closer.' }, {})
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_e', expect.objectContaining({
      custom: expect.objectContaining({ managed_by: 'closer' }),
    }))
  })

  it('does not set managed_by on non-handoff resultado', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_e', status_id: 'stat_pot', contacts: [],
      custom: {},
    })
    const tool = endCallTool(adapter)
    await tool.handler({ lead_id: 'lead_e', resultado: 'interesado', transcript: '' }, {})
    const callArg = (adapter.updateLead as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(callArg.custom).not.toHaveProperty('managed_by')
  })

  it('increments call_attempts counter', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.getLeadById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'lead_e', status_id: 'stat_pot', contacts: [],
      custom: { call_attempts: 1 },
    })
    const tool = endCallTool(adapter)
    await tool.handler({ lead_id: 'lead_e', resultado: 'no_disponible', transcript: '' }, {})
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_e', expect.objectContaining({
      custom: expect.objectContaining({ call_attempts: 2 }),
    }))
  })
})
