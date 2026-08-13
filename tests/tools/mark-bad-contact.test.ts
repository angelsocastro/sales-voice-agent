import { describe, it, expect, vi } from 'vitest'
import { markBadContactTool } from '../../src/tools/mark-bad-contact.js'
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

describe('markBadContactTool', () => {
  it('updates status to Bad Fit and creates a note', async () => {
    const adapter = makeMockAdapter()
    const tool = markBadContactTool(adapter)
    const result = await tool.handler(
      { lead_id: 'lead_123', motivo: 'numero_erroneo' },
      {}
    )
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_123', { statusLabel: 'Bad Fit' })
    expect(adapter.createNote).toHaveBeenCalledWith('lead_123', expect.stringContaining('numero_erroneo'))
    expect(result.content[0].text).toContain('lead_123')
    expect(result.isError).toBeUndefined()
  })

  it('returns error result on adapter failure', async () => {
    const adapter = makeMockAdapter()
    ;(adapter.updateLead as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'))
    const tool = markBadContactTool(adapter)
    const result = await tool.handler({ lead_id: 'lead_123', motivo: 'numero_erroneo' }, {})
    expect(result.isError).toBe(true)
  })
})
