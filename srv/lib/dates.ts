/**
 * Calendar helpers — local wall-clock only.
 *
 * Two rules run through this whole file:
 *
 * 1. **Never `new Date(isoString)`.** `new Date('2026-03-14')` is parsed as UTC
 *    midnight, which in Zurich is the 13th at 01:00 local — every date-only value
 *    would silently shift a day west of Greenwich. CONTRACTS §2.4 requires the
 *    feature pipeline to read `whenISO` as local wall-clock, and the classifier
 *    parity test fails to 1e-4 if a weekday moves. So dates are parsed with a
 *    regex and the digits are used as written.
 * 2. **Day arithmetic goes through epoch days, not milliseconds.** Adding
 *    86_400_000 ms to a local `Date` lands on the wrong day twice a year (DST).
 *    `Date.UTC(y, m, d)` is used purely as a proleptic-Gregorian day counter here;
 *    no timezone is ever applied to it.
 */

/** Thrown when a date string is not the shape CONTRACTS promises. */
export class DateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DateError'
  }
}

export interface WhenParts {
  /** `YYYY-MM-DD`, exactly as written in the input. */
  date: string
  /** `HH:MM` when the input carried a time, otherwise `null`. */
  time: string | null
  /** Hour of the local wall clock; 12 when the input carried no time (CONTRACTS §2.4). */
  hour: number
  /** Minute of the local wall clock; 0 when the input carried no time. */
  minute: number
  /** Day of week with **Monday = 0** … Sunday = 6, as the `dow_sin`/`dow_cos` features expect. */
  dow: number
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

// Accepts `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `...:SS`, optional fractional seconds,
// a space instead of the `T`, and a trailing zone designator. The zone is matched so
// that a value round-tripped through a driver still parses, but it is deliberately
// *ignored*: rule 1 above says the digits are the local wall clock.
const WHEN_ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

const MS_PER_DAY = 86_400_000
const DEFAULT_HOUR = 12
const DEFAULT_MINUTE = 0

interface CivilDate {
  year: number
  month: number
  day: number
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

/**
 * Day number since 1970-01-01, used as a pure counter (see rule 2 at the top).
 *
 * WHY not `Date.UTC(y, m - 1, d)`: it keeps the legacy two-digit-year rule, so a
 * year in `0`…`99` is silently read as `1900 + year`. A receipt whose date came
 * back from OCR as `0026-03-14` would then be counted 1900 years away, and
 * `epochDayOf` would disagree with `civilFromEpochDay` (which reads the real year)
 * — `addDays('0050-01-01', 1)` returned `'1950-01-02'`. This is the standard
 * days-from-civil formula: integer arithmetic, no `Date`, proleptic Gregorian,
 * identical to the old expression for every year from 0100 to 9999.
 */
function epochDayOf(civil: CivilDate): number {
  // March-based year: the leap day becomes the last day, so it never splits a month.
  const shiftedYear = civil.year - (civil.month <= 2 ? 1 : 0)
  const era = Math.floor(shiftedYear / 400)
  const yearOfEra = shiftedYear - era * 400
  const dayOfYear =
    Math.floor((153 * (civil.month + (civil.month > 2 ? -3 : 9)) + 2) / 5) + civil.day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  // 146097 days per 400-year era; 719468 days from 0000-03-01 to 1970-01-01.
  return era * 146097 + dayOfEra - 719468
}

function civilFromEpochDay(days: number): CivilDate {
  const point = new Date(days * MS_PER_DAY)
  return { year: point.getUTCFullYear(), month: point.getUTCMonth() + 1, day: point.getUTCDate() }
}

function formatCivil(civil: CivilDate): string {
  return `${pad4(civil.year)}-${pad2(civil.month)}-${pad2(civil.day)}`
}

/** Monday-first weekday of an epoch day. 1970-01-01 was a Thursday, hence the +3. */
function mondayIndex(days: number): number {
  return (((days + 3) % 7) + 7) % 7
}

function assertCalendarDate(civil: CivilDate, raw: string): void {
  if (civil.month < 1 || civil.month > 12) {
    throw new DateError(`month out of range in ${JSON.stringify(raw)}`)
  }
  if (civil.day < 1 || civil.day > daysInMonth(civil.year, civil.month)) {
    throw new DateError(`day out of range in ${JSON.stringify(raw)}`)
  }
}

/** Parse a `YYYY-MM-DD` string into calendar parts, rejecting impossible dates. */
function parseDate(date: string): CivilDate {
  if (typeof date !== 'string') {
    throw new DateError(`expected a YYYY-MM-DD string, got ${typeof date}`)
  }
  const match = DATE_ONLY.exec(date.trim())
  if (match === null) {
    throw new DateError(`${JSON.stringify(date)} is not a YYYY-MM-DD date`)
  }
  const civil = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  assertCalendarDate(civil, date)
  return civil
}

/**
 * Split `whenISO` into the pieces `numericFeatures` needs (CONTRACTS §2.4).
 *
 * WHY it is here and not inlined in the classifier: the Memories page, the
 * settlement period logic and the Python parity path all have to agree on what
 * "the 14th at 20:15" means, including the "no time means 12:00" rule that keeps
 * date-only imports from looking like 3 a.m. purchases.
 */
export function parseWhenISO(whenISO: string): WhenParts {
  if (typeof whenISO !== 'string') {
    throw new DateError(`whenISO must be a string, got ${typeof whenISO}`)
  }
  const match = WHEN_ISO.exec(whenISO.trim())
  if (match === null) {
    throw new DateError(`${JSON.stringify(whenISO)} is not YYYY-MM-DD[THH:MM[:SS]]`)
  }
  const civil = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  assertCalendarDate(civil, whenISO)

  // `.at()` rather than `match[4]`: optional groups really are absent, and the
  // index signature of RegExpExecArray would claim they are always strings.
  const hourGroup = match.at(4)
  const minuteGroup = match.at(5)
  const secondGroup = match.at(6)
  const hasTime = hourGroup !== undefined
  const hour = hourGroup === undefined ? DEFAULT_HOUR : Number(hourGroup)
  const minute = minuteGroup === undefined ? DEFAULT_MINUTE : Number(minuteGroup)
  const second = secondGroup === undefined ? 0 : Number(secondGroup)
  if (hour > 23 || minute > 59 || second > 59) {
    throw new DateError(`time out of range in ${JSON.stringify(whenISO)}`)
  }

  return {
    date: formatCivil(civil),
    time: hasTime ? `${pad2(hour)}:${pad2(minute)}` : null,
    hour,
    minute,
    dow: mondayIndex(epochDayOf(civil)),
  }
}

/**
 * ISO-8601 week key, e.g. `2026-W01`.
 *
 * WHY the Thursday trick: the ISO week-year is the year that owns the week's
 * Thursday, so 2025-12-29 belongs to `2026-W01` and 2027-01-01 to `2026-W53`.
 * Naively using the calendar year breaks the date-night streak count (CONTRACTS §8)
 * at every year boundary.
 */
export function isoWeekKey(date: string): string {
  const civil = parseDate(date)
  const days = epochDayOf(civil)
  const thursday = days + (3 - mondayIndex(days))
  const isoYear = civilFromEpochDay(thursday).year
  const isoYearStart = epochDayOf({ year: isoYear, month: 1, day: 1 })
  const week = Math.floor((thursday - isoYearStart) / 7) + 1
  return `${pad4(isoYear)}-W${pad2(week)}`
}

/** Move a `YYYY-MM-DD` date by whole days, crossing month and year ends correctly. */
export function addDays(date: string, days: number): string {
  if (!Number.isFinite(days)) {
    throw new DateError(`days must be a finite number, got ${String(days)}`)
  }
  return formatCivil(civilFromEpochDay(epochDayOf(parseDate(date)) + Math.trunc(days)))
}

/**
 * Whole days from `from` to `to`; negative when `to` is earlier.
 *
 * Calendar days, not elapsed time: `daysBetween('2026-03-28', '2026-03-29')` is 1
 * even though that Zurich night is only 23 hours long.
 */
export function daysBetween(from: string, to: string): number {
  return epochDayOf(parseDate(to)) - epochDayOf(parseDate(from))
}

/** Settlement period (`YYYY-MM`) a date falls into — the key used by Settlements. */
export function periodOf(date: string): string {
  const civil = parseDate(date)
  return `${pad4(civil.year)}-${pad2(civil.month)}`
}

export interface Anniversary {
  /** The upcoming (or today's) anniversary, `YYYY-MM-DD`. */
  date: string
  /** Whole days until it; `0` when it is today. */
  daysAway: number
  /** How many years that anniversary marks; `0` on the day itself. */
  yearsSince: number
}

/**
 * The anniversary of `occurredOn` that is next up as of `today`.
 *
 * Two rules the Memories countdown depends on:
 * - A 29 February anniversary falls back to 28 February in a non-leap year, so it
 *   is celebrated every year rather than every fourth one.
 * - "Today" counts as the anniversary (`daysAway: 0`), never as "just missed it,
 *   see you in 365 days".
 *
 * A future `occurredOn` returns itself with `yearsSince: 0`, so a planned date can
 * be counted down to with the same call.
 */
export function nextAnniversary(occurredOn: string, today: string): Anniversary {
  const origin = parseDate(occurredOn)
  const now = parseDate(today)
  const todayDay = epochDayOf(now)

  const occurrenceIn = (year: number): CivilDate => ({
    year,
    month: origin.month,
    // 29 Feb only exists in leap years; the household celebrates on the 28th otherwise.
    day: Math.min(origin.day, daysInMonth(year, origin.month)),
  })

  let year = Math.max(now.year, origin.year)
  let candidate = occurrenceIn(year)
  if (epochDayOf(candidate) < todayDay) {
    year += 1
    candidate = occurrenceIn(year)
  }

  return {
    date: formatCivil(candidate),
    daysAway: epochDayOf(candidate) - todayDay,
    yearsSince: year - origin.year,
  }
}

/**
 * Today as `YYYY-MM-DD` in the machine's own timezone.
 *
 * WHY not `new Date().toISOString().slice(0, 10)`: that is the UTC date, which in
 * Zurich is yesterday's date every evening after 22:00 (23:00 in winter) — an
 * expense scanned after dinner would be booked to the wrong day.
 */
export function todayISO(now: Date = new Date()): string {
  return formatCivil({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() })
}
