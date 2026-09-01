/**
 * Period helpers the Ledger needs on top of the shared ones in `@/theme`.
 *
 * `formatPeriod`, `currentPeriod`, `shiftPeriod`, `formatDate` and `formatTime` live in
 * the theme module and are used from there — this file only adds what a ledger needs:
 * a trailing window of months, compact axis labels, and day headings.
 */
import { shiftPeriod } from '@/theme'

const MONTH_SHORT = [
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

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export interface ParsedPeriod {
  year: number
  /** 1-12 */
  month: number
}

export function parsePeriod(period: string): ParsedPeriod {
  return { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) }
}

/** `count` periods ending at `end`, oldest first. */
export function periodWindow(end: string, count: number): string[] {
  const periods: string[] = []
  for (let index = count - 1; index >= 0; index -= 1) periods.push(shiftPeriod(end, -index))
  return periods
}

/** 'Sep' — and 'Sep 26' whenever the year rolls over, so a trend axis stays unambiguous. */
export function periodAxisLabel(period: string, previous?: string): string {
  const { year, month } = parsePeriod(period)
  const short = MONTH_SHORT[month - 1] ?? period
  const rollover = month === 1 || previous === undefined || parsePeriod(previous).year !== year
  return rollover ? `${short} ${String(year).slice(2)}` : short
}

/** Parse a `YYYY-MM-DD` value as a local date — never UTC shifted. */
export function parseIsoDate(iso: string): Date {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/** 'Today' · 'Yesterday' · 'Mon, 14 Sep' — the group header above a day of postings. */
export function dayHeading(iso: string, today: Date = new Date()): string {
  const date = parseIsoDate(iso)
  if (Number.isNaN(date.getTime())) return iso
  if (sameDay(date, today)) return 'Today'
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (sameDay(date, yesterday)) return 'Yesterday'
  return `${WEEKDAY_SHORT[date.getDay()]}, ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`
}
