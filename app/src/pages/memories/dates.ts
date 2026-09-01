/**
 * Calendar arithmetic for the Memories timeline.
 *
 * Everything here works on `YYYY-MM-DD` strings and plain {y, m, d} triples on
 * purpose. `new Date('2024-06-15')` parses as UTC midnight, which silently
 * shifts a date backwards by a day for anyone west of Greenwich — and an
 * anniversary that is off by one day is worse than no anniversary at all.
 * The only place a `Date` is used is `Date.UTC`, where both operands are
 * built the same way so the offset cancels out.
 */

export interface YMD {
  y: number
  m: number
  d: number
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** Accepts a date or a timestamp and keeps only the calendar part. */
export function parseIsoDate(value: string | null | undefined): YMD | null {
  if (!value) return null
  const match = ISO_DATE.exec(value)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12) return null
  if (d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

export function toIsoDate(ymd: YMD): string {
  return `${pad(ymd.y, 4)}-${pad(ymd.m)}-${pad(ymd.d)}`
}

/** Today as local wall-clock, not UTC. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() })
}

function utcMillis(ymd: YMD): number {
  return Date.UTC(ymd.y, ymd.m - 1, ymd.d)
}

const DAY_MS = 86_400_000

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function diffInDays(from: string, to: string): number {
  const a = parseIsoDate(from)
  const b = parseIsoDate(to)
  if (!a || !b) return 0
  return Math.round((utcMillis(b) - utcMillis(a)) / DAY_MS)
}

/**
 * Clamps a day-of-month into a target year/month. This is what makes a
 * 29 February memory land on 28 February in the three years out of four that
 * do not have one, instead of rolling over into March.
 */
export function clampToMonth(year: number, month: number, day: number): YMD {
  return { y: year, m: month, d: Math.min(day, daysInMonth(year, month)) }
}

/** `YYYY-MM` — the grouping key for a month section. */
export function periodOf(iso: string): string {
  const ymd = parseIsoDate(iso)
  return ymd ? `${pad(ymd.y, 4)}-${pad(ymd.m)}` : ''
}

export function monthLabel(period: string): string {
  const [y, m] = period.split('-')
  const index = Number(m) - 1
  if (!y || index < 0 || index > 11) return period
  return `${MONTH_NAMES[index]} ${y}`
}

/** Swiss short form, matching the Swiss money format used everywhere else. */
export function formatSwissDate(iso: string | null | undefined): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return ''
  return `${pad(ymd.d)}.${pad(ymd.m)}.${pad(ymd.y, 4)}`
}

/** `15 June 2024` — used where the date should read like prose. */
export function formatLongDate(iso: string | null | undefined): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return ''
  return `${ymd.d} ${MONTH_NAMES[ymd.m - 1]} ${ymd.y}`
}

/** Parses the `dd.MM.yyyy` the DatePicker hands back. */
export function parseSwissDate(value: string): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim())
  if (!match) return null
  const d = Number(match[1])
  const m = Number(match[2])
  const y = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return toIsoDate({ y, m, d })
}

export function daysUntilLabel(days: number): string {
  if (days <= 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `in ${days} days`
}

export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}
