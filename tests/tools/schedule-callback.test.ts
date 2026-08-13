import { describe, it, expect, vi } from 'vitest'
import { scheduleCallbackTool } from '../../src/tools/schedule-callback.js'
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

describe('scheduleCallbackTool', () => {
  it('creates task and updates lead when time is parseable', async () => {
    const adapter = makeMockAdapter()
    const tool = scheduleCallbackTool(adapter)
    const result = await tool.handler(
      { lead_id: 'lead_abc', texto_hora: 'mañana a las 10', nombre: 'Carlos' },
      {}
    )
    expect(adapter.createTask).toHaveBeenCalledWith(expect.objectContaining({
      lead_id: 'lead_abc',
      is_complete: false,
      type: 'lead',
    }))
    expect(adapter.updateLead).toHaveBeenCalledWith('lead_abc', expect.objectContaining({
      statusLabel: 'Called',
    }))
    expect(result.isError).toBeUndefined()
  })

  it('returns error when time cannot be parsed', async () => {
    const adapter = makeMockAdapter()
    const tool = scheduleCallbackTool(adapter)
    const result = await tool.handler(
      { lead_id: 'lead_abc', texto_hora: 'xyzabc' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(adapter.createTask).not.toHaveBeenCalled()
  })
})
