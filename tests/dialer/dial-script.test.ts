import { describe, it, expect } from 'vitest'
import { isCallableNow } from '../../src/dialer/dial-script.js'

// Monday 2026-06-15 10:00 Madrid time (UTC+2 in summer = 08:00 UTC)
const MONDAY_1000 = new Date('2026-06-15T08:00:00Z')
// Monday 2026-06-15 14:30 Madrid time (between windows)
const MONDAY_1430 = new Date('2026-06-15T12:30:00Z')
// Saturday 2026-06-20 10:00 Madrid
const SATURDAY_1000 = new Date('2026-06-20T08:00:00Z')

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
