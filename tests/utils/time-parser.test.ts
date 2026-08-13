import { describe, it, expect } from 'vitest'
import { parseSpanishTime } from '../../src/utils/time-parser.js'
import { toZonedTime } from 'date-fns-tz'

// Reference: Monday 2026-06-15 10:30 Madrid time
const NOW = new Date('2026-06-15T08:30:00Z')  // 10:30 Madrid (UTC+2 in summer)

function madridTime(d: Date) {
  return toZonedTime(d, 'Europe/Madrid')
}

describe('parseSpanishTime', () => {
  it('parses "mañana a las 10" → next day 10:00 Madrid', () => {
    const result = parseSpanishTime('mañana a las 10', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getDate()).toBe(16)
    expect(m.getHours()).toBe(10)
    expect(m.getMinutes()).toBe(0)
  })

  it('parses "mañana a las 10:30" → next day 10:30 Madrid', () => {
    const result = parseSpanishTime('mañana a las 10:30', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getHours()).toBe(10)
    expect(m.getMinutes()).toBe(30)
  })

  it('parses "pasado mañana por la tarde" → day+2 17:00 Madrid', () => {
    const result = parseSpanishTime('pasado mañana por la tarde', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getDate()).toBe(17)
    expect(m.getHours()).toBe(17)
  })

  it('parses "el lunes" → next Monday 09:00 Madrid', () => {
    // NOW is Monday, so next Monday is 2026-06-22
    const result = parseSpanishTime('el lunes', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getDay()).toBe(1)  // Monday
    expect(m.getDate()).toBe(22)
    expect(m.getHours()).toBe(9)
  })

  it('parses "el martes a las 11" → next Tuesday 11:00 Madrid', () => {
    const result = parseSpanishTime('el martes a las 11', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getDay()).toBe(2)
    expect(m.getHours()).toBe(11)
  })

  it('parses "ahora en verano no" → 2026-09-01 09:00 Madrid', () => {
    const result = parseSpanishTime('ahora en verano no', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getMonth()).toBe(8)  // September (0-indexed)
    expect(m.getDate()).toBe(1)
    expect(m.getHours()).toBe(9)
  })

  it('parses "a primera hora" → tomorrow 08:00 Madrid', () => {
    const result = parseSpanishTime('a primera hora', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getDate()).toBe(16)
    expect(m.getHours()).toBe(8)
  })

  it('parses "por la mañana" → tomorrow 09:00 Madrid', () => {
    const result = parseSpanishTime('por la mañana', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getHours()).toBe(9)
  })

  it('parses "por la tarde" → tomorrow 17:00 Madrid', () => {
    const result = parseSpanishTime('por la tarde', NOW)
    expect(result).not.toBeNull()
    const m = madridTime(result!)
    expect(m.getHours()).toBe(17)
  })

  it('returns null for unparseable text', () => {
    expect(parseSpanishTime('xyzabc', NOW)).toBeNull()
  })
})
