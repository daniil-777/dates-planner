/**
 * Calendar arithmetic for events.
 *
 * Everything works on `YYYY-MM-DD` strings and plain {y, m, d} triples. `new Date('2026-04-10')`
 * parses as UTC midnight, which shifts the day backwards for anyone west of Greenwich — and a
 * trip that starts the day before it started is the kind of bug nobody reports and everybody
 * notices. The only `Date` used here is `Date.UTC`, where both operands are built the same way
 * so the offset cancels out.
 */

export interface YMD {
  y: number
  m: number
  d: number
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/
const SWISS_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** The dash between two dates is an en dash, the way a printed itinerary sets it. */
const RANGE_DASH = '–'

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

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

export function toIsoDate(ymd: YMD): string {
  return `${pad(ymd.y, 4)}-${pad(ymd.m)}-${pad(ymd.d)}`
}

/** Today as local wall-clock, not UTC. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() })
}

/** Whole days from `from` to `to`; negative when `to` is the earlier of the two. */
export function diffInDays(from: string, to: string): number {
  const a = parseIsoDate(from)
  const b = parseIsoDate(to)
  if (!a || !b) return 0
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000)
}

/** Swiss short form for the DatePicker: `10.04.2026`. */
export function formatSwissDate(iso: string | null | undefined): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return ''
  return `${pad(ymd.d)}.${pad(ymd.m)}.${pad(ymd.y, 4)}`
}

/** Parses the `dd.MM.yyyy` the DatePicker hands back. Empty input is a deliberate `null`. */
export function parseSwissDate(value: string): string | null {
  const match = SWISS_DATE.exec(value.trim())
  if (!match) return null
  const d = Number(match[1])
  const m = Number(match[2])
  const y = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return toIsoDate({ y, m, d })
}

/** `2026-04-10` → `10 Apr 2026`. */
export function formatDay(iso: string | null | undefined): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return ''
  return `${ymd.d} ${MONTHS_SHORT[ymd.m - 1]} ${ymd.y}`
}

/**
 * The heading date of an event, written the way a person would:
 *
 * ```
 * ('2026-06-15', null)          → '15 Jun 2026'
 * ('2026-04-10', '2026-04-13')  → '10 – 13 Apr 2026'
 * ('2026-03-28', '2026-04-02')  → '28 Mar – 2 Apr 2026'
 * ('2025-12-28', '2026-01-02')  → '28 Dec 2025 – 2 Jan 2026'
 * ```
 *
 * Repeating the month or the year only when it actually changes is what keeps a weekend
 * from reading like two separate dates stapled together.
 */
export function formatDateRange(
  startsOn: string | null | undefined,
  endsOn: string | null | undefined,
): string {
  const start = parseIsoDate(startsOn)
  const end = parseIsoDate(endsOn)
  if (!start) return end ? formatDay(endsOn) : '—'
  if (!end || toIsoDate(end) === toIsoDate(start)) return formatDay(startsOn)

  const startMonth = MONTHS_SHORT[start.m - 1]
  const endMonth = MONTHS_SHORT[end.m - 1]
  if (start.y !== end.y) {
    return `${start.d} ${startMonth} ${start.y} ${RANGE_DASH} ${end.d} ${endMonth} ${end.y}`
  }
  if (start.m !== end.m) {
    return `${start.d} ${startMonth} ${RANGE_DASH} ${end.d} ${endMonth} ${end.y}`
  }
  return `${start.d} ${RANGE_DASH} ${end.d} ${startMonth} ${start.y}`
}

/** `'One day'`, `'4 days'` — how long the event ran, both ends included. */
export function spanLabel(
  startsOn: string | null | undefined,
  endsOn: string | null | undefined,
): string {
  const start = parseIsoDate(startsOn)
  if (!start) return ''
  const end = parseIsoDate(endsOn)
  if (!end) return 'One day'
  const days = diffInDays(toIsoDate(start), toIsoDate(end)) + 1
  if (days <= 1) return 'One day'
  return `${days} days`
}

/** The last day an event covers: its end if it has one, otherwise the day it started. */
export function lastDayOf(startsOn: string, endsOn: string | null): string {
  const end = parseIsoDate(endsOn)
  return end ? toIsoDate(end) : startsOn
}
