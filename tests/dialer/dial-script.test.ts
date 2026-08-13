import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isCallableNow, buildAiCallPayload } from '../../src/dialer/dial-script.js'
import type { Lead } from '../../src/crm/adapter.js'

// Monday 2026-06-15 10:00 Madrid time (UTC+2 in summer = 08:00 UTC)
const MONDAY_1000 = new Date('2026-06-15T08:00:00Z')
// Monday 2026-06-15 14:30 Madrid time (between windows)
const MONDAY_1430 = new Date('2026-06-15T12:30:00Z')
// Saturday 2026-06-20 10:00 Madrid
const SATURDAY_1000 = new Date('2026-06-20T08:00:00Z')

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

describe('isCallableNow', () => {
  it('returns true during morning window (09:00–14:00 Monday)', () => {
    expect(isCallableNow(MONDAY_1000)).toBe(true)
  })

  it('returns false between windows (14:30 Monday)', () => {
    expect(isCallableNow(MONDAY_1430)).toBe(false)
  })

  it('returns false on Saturday', () => {
    expect(isCallableNow(SATURDAY_1000)).toBe(false)
  })

  it('returns true during afternoon window (17:00 Monday)', () => {
    // 17:00 Madrid = 15:00 UTC in summer
    const monday1700 = new Date('2026-06-15T15:00:00Z')
    expect(isCallableNow(monday1700)).toBe(true)
  })

  it('returns false after evening window (19:00+)', () => {
    // 19:30 Madrid = 17:30 UTC
    const monday1930 = new Date('2026-06-15T17:30:00Z')
    expect(isCallableNow(monday1930)).toBe(false)
  })
})

describe('buildAiCallPayload', () => {
  it('includes required Telnyx fields and dynamic variables', () => {
    const lead = makeLead()
    const payload = buildAiCallPayload(lead, {
      assistantId: 'asst_123',
      fromNumber: '+34900000000',
      appId: 'app_abc',
    })
    expect(payload).toMatchObject({
      AIAssistantId: 'asst_123',
      From: '+34900000000',
    })
    expect(payload.custom_headers).toBeDefined()
    // lead_id is now in conversation_metadata, not Variables
    expect(payload.conversation_metadata?.lead_id).toBe('lead_test')
    expect(payload.Variables).not.toHaveProperty('lead_id')
  })

  it('sets conversation_metadata.lead_id and three dynamic variables', () => {
    const lead = makeLead({ notes: 'Interested in plan A' })
    const payload = buildAiCallPayload(lead, {
      assistantId: 'asst_123',
      fromNumber: '+34900000000',
      appId: 'app_abc',
    })
    expect(payload.conversation_metadata).toEqual({ lead_id: 'lead_test' })
    expect(payload.Variables).toEqual({
      company_name: 'Test Company',
      phone: '+34600000001',
      notes: 'Interested in plan A',
    })
    expect(payload.Variables).not.toHaveProperty('lead_id')
  })

  it('defaults notes to empty string when not set', () => {
    const lead = makeLead()
    const payload = buildAiCallPayload(lead, {
      assistantId: 'asst_123',
      fromNumber: '+34900000000',
      appId: 'app_abc',
    })
    expect(payload.Variables?.notes).toBe('')
  })

  it('uses first mobile phone of first contact', () => {
    const lead = makeLead()
    const payload = buildAiCallPayload(lead, {
      assistantId: 'asst_123',
      fromNumber: '+34900000000',
      appId: 'app_abc',
    })
    expect(payload.To).toBe('+34600000001')
  })

  it('throws when lead has no phone', () => {
    const lead = makeLead({ contacts: [{ id: 'c1', name: 'X', phones: [] }] })
    expect(() => buildAiCallPayload(lead, {
      assistantId: 'asst_123',
      fromNumber: '+34900000000',
      appId: 'app_abc',
    })).toThrow('no phone')
  })
})
