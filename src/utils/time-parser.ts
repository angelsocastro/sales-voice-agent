import { addDays, setHours, setMinutes, nextDay, startOfDay } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

const TZ = 'Europe/Madrid'

const DAYS: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3,
  jueves: 4, viernes: 5, sábado: 6, sabado: 6,
}

function setMadridHour(date: Date, hour: number, minute = 0): Date {
  const zoned = toZonedTime(date, TZ)
  const withTime = setMinutes(setHours(startOfDay(zoned), hour), minute)
  return fromZonedTime(withTime, TZ)
}

function parseHour(text: string): { hour: number; minute: number } | null {
  const match = text.match(/(?:a las?|las?)\s+(\d{1,2})(?:[:\.](\d{2}))?/)
  if (match) {
    return { hour: parseInt(match[1], 10), minute: parseInt(match[2] ?? '0', 10) }
  }
  return null
}

function inferHour(text: string): number {
  if (/primera hora|temprano/.test(text)) return 8
  if (/por la mañana|mañana/.test(text) && !/pasado|mañana a las/.test(text)) return 9
  if (/mediodía|mediodia/.test(text)) return 12
  if (/por la tarde|tarde/.test(text)) return 17
  if (/por la noche|noche/.test(text)) return 20
  return 9  // default: morning
}

export function parseSpanishTime(text: string, now: Date = new Date()): Date | null {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

  // "ahora en verano no" → September 1st
  if (/verano/.test(t)) {
    const year = now.getFullYear()
    const sep1 = fromZonedTime(new Date(year, 8, 1, 9, 0, 0), TZ)
    return sep1 > now ? sep1 : fromZonedTime(new Date(year + 1, 8, 1, 9, 0, 0), TZ)
  }

  const parsed = parseHour(text.toLowerCase())
  const hour = parsed?.hour ?? inferHour(t)
  const minute = parsed?.minute ?? 0

  // "pasado mañana"
  if (/pasado manana/.test(t)) {
    return setMadridHour(addDays(now, 2), hour, minute)
  }

  // "mañana a las X" or "mañana"
  if (/\bmanana\b/.test(t) || /^a las/.test(t) || /^las \d/.test(t)) {
    if (/\bmanana\b/.test(t) || !parsed) {
      return setMadridHour(addDays(now, 1), hour, minute)
    }
    // "a las X" same day if time is in future, else tomorrow
    const today = setMadridHour(now, hour, minute)
    return today > now ? today : setMadridHour(addDays(now, 1), hour, minute)
  }

  // Named weekday: "el lunes", "el martes a las 11"
  for (const [name, dayNum] of Object.entries(DAYS)) {
    const normalized = name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    if (t.includes(normalized)) {
      const base = nextDay(now, dayNum as 0 | 1 | 2 | 3 | 4 | 5 | 6)
      return setMadridHour(base, hour, minute)
    }
  }

  // "primera hora", "por la mañana/tarde" with no day → tomorrow
  if (/primera hora|por la manana|por la tarde|por la noche/.test(t)) {
    return setMadridHour(addDays(now, 1), hour, minute)
  }

  return null
}
