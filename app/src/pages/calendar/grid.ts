/**
 * The month grid, and the two pieces of date arithmetic the calendar needs that
 * nothing in the app had yet.
 *
 * Everything else is imported: `parseIsoDate`, `toIsoDate`, `todayIso`,
 * `daysInMonth` and `diffInDays` already exist in `pages/memories/dates.ts`,
 * written for the anniversary maths and correct about the two things that break
 * calendars — leap years, and `new Date('2026-03-01')` parsing as UTC midnight and
 * so rendering as 28 February for anyone west of Greenwich. There is no reason for
 * a second copy of them, and every reason not to have one.
 *
 * What is new here is `addDays` (the anniversary code never needed to step a day)
 * and `weekdayIndex`. Both go through `Date.UTC`, where the offset cancels out
 * because both operands are built the same way; no local-time `Date` is ever
 * constructed from a `YYYY-MM-DD` string.
 *
 * The week starts on Monday. This is a Swiss household ledger; Sunday is the last
 * column of the weekend, not the first column of the week.
 */

import { daysInMonth, parseIsoDate, toIsoDate, todayIso } from '../memories/dates'

/** Monday first — the column headings, and the order `weekdayIndex` counts in. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** Full names for the cells' accessible labels, in the same order. */
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

const PERIOD_RE = /^(\d{4})-(\d{2})$/

const DAY_MS = 86_400_000

/** One square of the grid. Trailing and leading days are real days, just not this month's. */
export interface DayCell {
  /** `YYYY-MM-DD`. */
  date: string
  /** 1..31, the number printed in the corner. */
  day: number
  /** False for the greyed-out days either side of the month. */
  inMonth: boolean
  isToday: boolean
  /** 0 = Monday … 6 = Sunday. */
  weekday: number
}

/**
 * `n` days after `iso` — negative steps backwards. Returns `iso` untouched when it is
 * not a date, so a bad value never turns into `NaN-NaN-NaN` halfway down the page.
 */
export function addDays(iso: string, delta: number): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return iso
  const shifted = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d) + Math.round(delta) * DAY_MS)
  return toIsoDate({
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  })
}

/** 0 = Monday … 6 = Sunday. `-1` when the string is not a date. */
export function weekdayIndex(iso: string): number {
  const ymd = parseIsoDate(iso)
  if (!ymd) return -1
  // getUTCDay is 0 = Sunday; rotate so Monday leads.
  return (new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay() + 6) % 7
}

/** `'2026-02'` → `'2026-02-01'`, or null when the period is malformed. */
function firstDayOf(period: string): string | null {
  const match = PERIOD_RE.exec(period)
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  if (m < 1 || m > 12) return null
  return toIsoDate({ y, m, d: 1 })
}

/**
 * Every square of one month's grid, always a whole number of weeks.
 *
 * February 2024 (29 days, starting on a Thursday) is 3 leading days + 29 = 32, padded
 * to 35. March 2026 (31 days, starting on a Sunday) is 6 leading + 31 = 37, padded to
 * 42 — the six-week month that a grid hard-coded to five weeks silently truncates.
 */
export function monthGrid(period: string, today: string = todayIso()): DayCell[] {
  const first = firstDayOf(period)
  if (!first) return []
  const ymd = parseIsoDate(first)
  if (!ymd) return []

  const lead = weekdayIndex(first)
  const length = daysInMonth(ymd.y, ymd.m)
  const cellCount = Math.ceil((lead + length) / 7) * 7
  const start = addDays(first, -lead)

  const cells: DayCell[] = []
  for (let index = 0; index < cellCount; index += 1) {
    const date = addDays(start, index)
    const parsed = parseIsoDate(date)
    cells.push({
      date,
      day: parsed ? parsed.d : 0,
      inMonth: parsed !== null && parsed.y === ymd.y && parsed.m === ymd.m,
      isToday: date === today,
      weekday: index % 7,
    })
  }
  return cells
}

/** The same cells, cut into rows of seven for a `role="row"` each. */
export function weeksOf(cells: readonly DayCell[]): DayCell[][] {
  const weeks: DayCell[][] = []
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7))
  }
  return weeks
}

/** `'2026-03-14'` → `'2026-03'`. The period a focused day belongs to. */
export function periodOfDate(iso: string): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return ''
  return `${String(ymd.y).padStart(4, '0')}-${String(ymd.m).padStart(2, '0')}`
}

/**
 * The day to land on when a month is paged with the buttons: the same day number
 * where the new month has one, and its last day where it does not — 31 January
 * paged forward is 28 February, not 3 March.
 */
export function sameDayInPeriod(period: string, date: string): string {
  const first = firstDayOf(period)
  if (!first) return date
  const target = parseIsoDate(first)
  const source = parseIsoDate(date)
  if (!target) return date
  const day = source ? Math.min(source.d, daysInMonth(target.y, target.m)) : 1
  return toIsoDate({ y: target.y, m: target.m, d: day })
}
