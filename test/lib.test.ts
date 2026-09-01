/**
 * Behavioural tests for the stage-1 pure libraries.
 *
 * These four modules have no I/O and no CDS dependency, so everything below runs
 * in-process with no server, no database and no fixtures on disk. The images
 * suite builds its own test bitmaps with sharp rather than committing binaries —
 * a 3000 px JPEG of flat colour is 12 kB and always regenerates identically.
 *
 * The rule for this file: assert what the libraries *contract* to do
 * (docs/CONTRACTS.md §2.4 and §9, plus each module's own header), never what a
 * particular implementation happens to return today.
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { MoneyError, fromCents, round2, sumMoney, toAmount, toCents } from '../srv/lib/money'
import {
  DateError,
  addDays,
  daysBetween,
  isoWeekKey,
  nextAnniversary,
  parseWhenISO,
  periodOf,
  todayISO,
} from '../srv/lib/dates'
import { forecast, holtWinters, planTrip } from '../srv/lib/forecast'
import {
  ImageError,
  MAX_LONG_EDGE,
  MAX_UPLOAD_BYTES,
  isSupportedImageType,
  processReceiptImage,
  thumbnail,
} from '../srv/lib/images'

/* ------------------------------------------------------------------ money */

describe('money — rounding', () => {
  it('rounds half-up at genuine .005 boundaries', () => {
    // 1.005 and 2.675 are the classic traps: both are *below* the decimal
    // midpoint in IEEE-754, so `Math.round(x * 100)` rounds them down.
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(0.615)).toBe(0.62)
    expect(round2(2.345)).toBe(2.35)
    expect(round2(1.045)).toBe(1.05)
    expect(round2(0.005)).toBe(0.01)
  })

  it('rounds half **away from zero**, not towards +Infinity', () => {
    // CONTRACTS §9 half-up is the commercial convention: -2.345 -> -2.35.
    // Math.round(-234.5) would give -234, i.e. -2.34.
    expect(round2(-1.005)).toBe(-1.01)
    expect(round2(-2.345)).toBe(-2.35)
    expect(round2(-0.005)).toBe(-0.01)
  })

  it('normalises negative zero away', () => {
    expect(Object.is(round2(-0.001), 0)).toBe(true)
    expect(Object.is(fromCents(-0), 0)).toBe(true)
    expect(Object.is(toCents(-0.004), 0)).toBe(true)
  })

  it('leaves values that need no rounding untouched', () => {
    expect(round2(148.5)).toBe(148.5)
    expect(round2(0)).toBe(0)
    expect(round2(99999999.99)).toBe(99999999.99)
  })

  it('rejects non-finite amounts instead of laundering a NaN', () => {
    expect(() => round2(Number.NaN)).toThrow(MoneyError)
    expect(() => round2(Number.POSITIVE_INFINITY)).toThrow(MoneyError)
    expect(() => toCents(Number.NaN)).toThrow(/finite/)
  })
})

describe('money — cents round trips', () => {
  it('converts amounts to whole cents', () => {
    expect(toCents(148.5)).toBe(14850)
    expect(toCents(0.1)).toBe(10)
    expect(toCents(-12.34)).toBe(-1234)
    expect(toCents(1.005)).toBe(101)
    expect(toCents(0)).toBe(0)
  })

  it('round-trips every Decimal(10,2) value it is given', () => {
    const values = [0, 0.01, -0.01, 0.1, 12.34, -12.34, 148.5, 1234.56, 99999999.99, -99999999.99]
    for (const value of values) {
      expect(fromCents(toCents(value))).toBe(value)
    }
  })

  it('round-trips cents through amounts and back', () => {
    for (const cents of [0, 1, -1, 99, 14850, -14850, 9999999999]) {
      expect(toCents(fromCents(cents))).toBe(cents)
    }
  })

  it('rounds fractional cents half-up rather than rejecting them', () => {
    // fromCents is the single rounding point at the end of a calculation, so
    // `fromCents(toCents(x) / 2)` has to stay legal.
    expect(fromCents(0.5)).toBe(0.01)
    expect(fromCents(-0.5)).toBe(-0.01)
    expect(fromCents(1.4)).toBe(0.01)
    expect(fromCents(toCents(0.05) / 2)).toBe(0.03)
  })

  it('refuses amounts outside the exactly-representable range', () => {
    expect(() => toCents(1e15)).toThrow(/outside the range/)
    expect(() => fromCents(Number.MAX_SAFE_INTEGER + 10)).toThrow(/outside the range/)
  })
})

describe('money — sumMoney', () => {
  it('sums without binary drift and rounds exactly once', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3)
    expect(sumMoney([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])).toBe(4.5)
    expect(sumMoney([19, 46, 44, 24, 5.9, 9.6])).toBe(148.5)
  })

  it('rounds the total, not each addend', () => {
    // Two half-rappen addends are one rappen together, not two.
    expect(sumMoney([0.005, 0.005])).toBe(0.01)
    expect(round2(0.005) + round2(0.005)).toBe(0.02)
  })

  it('sums nothing to zero rather than throwing', () => {
    expect(sumMoney([])).toBe(0)
  })

  it('still rejects a NaN hidden in the middle of the list', () => {
    expect(() => sumMoney([1, Number.NaN, 2])).toThrow(MoneyError)
  })
})

describe('money — toAmount', () => {
  it('accepts a number, because some drivers return Decimals as numbers', () => {
    expect(toAmount(148.5)).toBe(148.5)
    expect(toAmount(0)).toBe(0)
    expect(toAmount(-3)).toBe(-3)
  })

  it('accepts a decimal string, because other drivers return Decimals as strings', () => {
    expect(toAmount('148.50')).toBe(148.5)
    expect(toAmount('  12.50  ')).toBe(12.5)
    expect(toAmount('.5')).toBe(0.5)
    expect(toAmount('-3')).toBe(-3)
    expect(toAmount('+3.25')).toBe(3.25)
    expect(toAmount('0')).toBe(0)
  })

  it('accepts a bigint within the exact range', () => {
    expect(toAmount(148n)).toBe(148)
    expect(() => toAmount(BigInt(Number.MAX_SAFE_INTEGER) + 2n)).toThrow(/too large/)
  })

  it('throws on garbage instead of quietly producing NaN', () => {
    expect(() => toAmount(null)).toThrow(MoneyError)
    expect(() => toAmount(undefined)).toThrow(MoneyError)
    expect(() => toAmount({})).toThrow(MoneyError)
    expect(() => toAmount([])).toThrow(MoneyError)
    expect(() => toAmount(true)).toThrow(MoneyError)
    expect(() => toAmount('abc')).toThrow(/not a decimal number/)
    expect(() => toAmount('')).toThrow(/not a decimal number/)
    expect(() => toAmount('   ')).toThrow(/not a decimal number/)
    expect(() => toAmount(Number.NaN)).toThrow(/finite/)
    expect(() => toAmount(Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })

  it('rejects a comma decimal — that is a locale bug, not an amount', () => {
    // "1,50" from a European UI must fail loudly rather than become 1 or 150.
    expect(() => toAmount('1,50')).toThrow(MoneyError)
    expect(() => toAmount("1'234.50")).toThrow(MoneyError)
  })
})

/* ------------------------------------------------------------------ dates */

describe('dates — parseWhenISO', () => {
  it('reads a date-only value as noon local (CONTRACTS §2.4)', () => {
    expect(parseWhenISO('2026-03-14')).toEqual({
      date: '2026-03-14',
      time: null,
      hour: 12,
      minute: 0,
      dow: 5,
    })
  })

  it('reads a wall-clock time when one is present', () => {
    expect(parseWhenISO('2026-03-14T20:15')).toEqual({
      date: '2026-03-14',
      time: '20:15',
      hour: 20,
      minute: 15,
      dow: 5,
    })
    expect(parseWhenISO('2026-03-14T20:15:30')).toMatchObject({ time: '20:15', hour: 20 })
    expect(parseWhenISO('2026-03-14T20:15:30.123')).toMatchObject({ time: '20:15', minute: 15 })
    // A space instead of the T is what SQLite hands back.
    expect(parseWhenISO('2026-03-14 20:15')).toMatchObject({ time: '20:15', hour: 20 })
  })

  it('ignores a trailing Z — the digits are the local wall clock', () => {
    // NOT 21:15 or 22:15: CONTRACTS §2.4 forbids a UTC shift, because the
    // classifier's is_evening / hour_sin features are about the local evening.
    expect(parseWhenISO('2026-03-14T20:15:00Z')).toEqual({
      date: '2026-03-14',
      time: '20:15',
      hour: 20,
      minute: 15,
      dow: 5,
    })
  })

  it('ignores a +02:00 offset rather than applying it', () => {
    expect(parseWhenISO('2026-03-14T20:15:00+02:00')).toEqual({
      date: '2026-03-14',
      time: '20:15',
      hour: 20,
      minute: 15,
      dow: 5,
    })
    expect(parseWhenISO('2026-03-14T20:15+0200')).toMatchObject({ hour: 20, date: '2026-03-14' })
    expect(parseWhenISO('2026-03-14T00:30-05:00')).toMatchObject({
      date: '2026-03-14',
      hour: 0,
      minute: 30,
    })
  })

  it('numbers the weekday Monday = 0 … Sunday = 6', () => {
    // 2026-03-16 is a Monday.
    const week = [
      ['2026-03-16', 0],
      ['2026-03-17', 1],
      ['2026-03-18', 2],
      ['2026-03-19', 3],
      ['2026-03-20', 4],
      ['2026-03-21', 5],
      ['2026-03-22', 6],
    ] as const
    for (const [date, dow] of week) {
      expect(parseWhenISO(date).dow).toBe(dow)
    }
  })

  it('agrees with the platform calendar on the weekday for a whole year', () => {
    for (let day = 0; day < 366; day += 1) {
      const probe = new Date(Date.UTC(2026, 0, 1 + day))
      const iso = probe.toISOString().slice(0, 10)
      expect(parseWhenISO(iso).dow).toBe((probe.getUTCDay() + 6) % 7)
    }
  })

  it('accepts a real leap day and rejects a fake one', () => {
    expect(parseWhenISO('2024-02-29').date).toBe('2024-02-29')
    expect(() => parseWhenISO('2026-02-29')).toThrow(DateError)
    expect(() => parseWhenISO('2100-02-29')).toThrow(DateError)
    expect(parseWhenISO('2000-02-29').date).toBe('2000-02-29')
  })

  it('rejects anything that is not YYYY-MM-DD[THH:MM[:SS]]', () => {
    for (const bad of ['', 'nonsense', '14.03.2026', '2026-3-4', '2026-13-01', '2026-02-30']) {
      expect(() => parseWhenISO(bad)).toThrow(DateError)
    }
    expect(() => parseWhenISO('2026-03-14T24:00')).toThrow(/time out of range/)
    expect(() => parseWhenISO('2026-03-14T20:60')).toThrow(/time out of range/)
  })
})

describe('dates — isoWeekKey', () => {
  it('puts a late-December Monday into the next ISO year', () => {
    // 2025-12-29 is a Monday whose Thursday is 2026-01-01.
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01')
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01')
  })

  it('keeps an early-January date in the previous ISO year when the week does', () => {
    // 2026 is a 53-week ISO year (1 January 2026 is a Thursday).
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53')
    expect(isoWeekKey('2027-01-03')).toBe('2026-W53')
    expect(isoWeekKey('2027-01-04')).toBe('2027-W01')
    expect(isoWeekKey('2021-01-01')).toBe('2020-W53')
  })

  it('matches the platform ISO week for every day from 1990 to 2059', () => {
    const reference = (probe: Date): string => {
      const thursday = new Date(probe.getTime())
      thursday.setUTCDate(thursday.getUTCDate() - ((probe.getUTCDay() + 6) % 7) + 3)
      const isoYear = thursday.getUTCFullYear()
      const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
      firstThursday.setUTCDate(
        firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3,
      )
      const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000))
      return `${isoYear}-W${String(week).padStart(2, '0')}`
    }
    const cursor = new Date(Date.UTC(1990, 0, 1))
    let checked = 0
    while (cursor.getUTCFullYear() < 2060) {
      expect(isoWeekKey(cursor.toISOString().slice(0, 10))).toBe(reference(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      checked += 1
    }
    expect(checked).toBeGreaterThan(25_000)
  })
})

describe('dates — day arithmetic', () => {
  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-03-14', 0)).toBe('2026-03-14')
  })

  it('counts calendar days, including the DST weekend', () => {
    // The Zurich night of 28 March 2026 is 23 hours long; it is still one day.
    expect(daysBetween('2026-03-28', '2026-03-29')).toBe(1)
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59)
    expect(daysBetween('2026-03-01', '2026-01-01')).toBe(-59)
    expect(daysBetween('2026-03-14', '2026-03-14')).toBe(0)
  })

  it('derives the settlement period from a date', () => {
    expect(periodOf('2026-03-14')).toBe('2026-03')
    expect(periodOf('2026-12-31')).toBe('2026-12')
  })

  it('reads today from the local clock, not from UTC', () => {
    // 23:30 local on 5 January is already the 6th in UTC anywhere east of Greenwich.
    expect(todayISO(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
    expect(todayISO(new Date(2026, 11, 31, 0, 5))).toBe('2026-12-31')
  })
})

describe('dates — nextAnniversary', () => {
  it('falls back to 28 February for a 29 February date in a non-leap year', () => {
    expect(nextAnniversary('2024-02-29', '2026-01-01')).toEqual({
      date: '2026-02-28',
      daysAway: 58,
      yearsSince: 2,
    })
  })

  it('celebrates a 29 February date on the real day in a leap year', () => {
    expect(nextAnniversary('2024-02-29', '2028-01-01')).toEqual({
      date: '2028-02-29',
      daysAway: 59,
      yearsSince: 4,
    })
  })

  it('counts today as the anniversary, not as just missed', () => {
    expect(nextAnniversary('2024-06-15', '2026-06-15')).toEqual({
      date: '2026-06-15',
      daysAway: 0,
      yearsSince: 2,
    })
    expect(nextAnniversary('2024-02-29', '2026-02-28')).toMatchObject({ daysAway: 0 })
  })

  it('rolls to next year the day after, and counts the years', () => {
    expect(nextAnniversary('2024-06-15', '2026-06-16')).toEqual({
      date: '2027-06-15',
      daysAway: 364,
      yearsSince: 3,
    })
    expect(nextAnniversary('2024-06-15', '2026-12-31').yearsSince).toBe(3)
  })

  it('counts down to a future date with yearsSince 0', () => {
    expect(nextAnniversary('2027-01-01', '2026-06-01')).toEqual({
      date: '2027-01-01',
      daysAway: 214,
      yearsSince: 0,
    })
  })

  it('reports the first anniversary on the day it happened', () => {
    expect(nextAnniversary('2024-06-15', '2024-06-15')).toEqual({
      date: '2024-06-15',
      daysAway: 0,
      yearsSince: 0,
    })
  })
})

/* --------------------------------------------------------------- forecast */

/**
 * Three years of monthly household spend: a level of CHF 3200, a CHF 12/month
 * drift, a December spike and a February dip, plus a fixed non-seasonal wobble
 * so the residual sigma is genuinely non-zero (a noiseless series fits exactly
 * and collapses the band onto the point, which would make the band assertions
 * vacuous).
 */
const SEASONAL_OFFSETS = [0, -120, -60, 40, 90, 60, 30, -20, 10, 70, 150, 420]
const WOBBLE = [
  18, -32, 7, -14, 41, -9, 23, -37, 12, -21, 5, 29, -16, 34, -6, 11, -28, 3, 26, -19, 8, -41, 15,
  -2, 31, -13, 22, -35, 9, 17, -24, 6, 38, -11, 4, -27,
]

function seasonalSeries(months: number): number[] {
  const out: number[] = []
  for (let t = 0; t < months; t += 1) {
    out.push(3200 + 12 * t + SEASONAL_OFFSETS[t % 12] + WOBBLE[t % WOBBLE.length])
  }
  return out
}

describe('forecast — holtWinters', () => {
  it('fits additive Holt-Winters once two full seasons exist', () => {
    const fit = holtWinters(seasonalSeries(36))
    expect(fit.method).toBe('holt-winters')
    expect(fit.seasonLength).toBe(12)
    expect(fit.season).toHaveLength(12)
    expect(fit.fitted).toHaveLength(36)
    expect(fit.residuals).toHaveLength(36)
    expect(fit.fitFrom).toBe(12)
    expect(fit.sigma).toBeGreaterThan(0)
    expect(Number.isFinite(fit.level)).toBe(true)
    expect(fit.season.every(Number.isFinite)).toBe(true)
    // The initialisation window is not scored, so those residuals are exactly 0.
    expect(fit.residuals.slice(0, 12).every(value => value === 0)).toBe(true)
  })

  it('is deterministic — the same series fits the same parameters twice', () => {
    const a = holtWinters(seasonalSeries(36))
    const b = holtWinters(seasonalSeries(36))
    expect([a.alpha, a.beta, a.gamma, a.phi]).toEqual([b.alpha, b.beta, b.gamma, b.phi])
    expect(a.sse).toBe(b.sse)
  })

  it('drops to damped Holt for a short series and to the last value for a tiny one', () => {
    expect(holtWinters([1200, 1350, 1180, 1420, 1500]).method).toBe('damped-holt')
    expect(holtWinters([1200, 1350, 1180, 1420]).method).toBe('damped-holt')
    expect(holtWinters([1200, 1350, 1180]).method).toBe('last-value')
    expect(holtWinters([1200]).method).toBe('last-value')
  })

  it('repeats the last season when one fits but there is no room for a trend fit', () => {
    const fit = holtWinters([10, 20, 30], { seasonLength: 3, minSeasonalPoints: 99 })
    expect(fit.method).toBe('seasonal-naive')
    expect(fit.predict(1)).toBe(10)
    expect(fit.predict(4)).toBe(10)
  })

  it('returns an empty fit for an empty series rather than throwing', () => {
    const fit = holtWinters([])
    expect(fit.method).toBe('empty')
    expect(fit.fitted).toEqual([])
    expect(fit.residuals).toEqual([])
    expect(fit.season).toEqual([])
    expect(fit.sigma).toBe(0)
    expect(fit.predict(1)).toBe(0)
  })

  it('survives a series that is entirely NaN', () => {
    const fit = holtWinters([Number.NaN, Number.NaN, Number.NaN, Number.NaN])
    expect(Number.isFinite(fit.level)).toBe(true)
    expect(fit.fitted.every(Number.isFinite)).toBe(true)
    expect(Number.isFinite(fit.predict(3))).toBe(true)
  })
})

describe('forecast — forecast()', () => {
  it('produces a sane 6-month forecast from 36 months of seasonal history', () => {
    const series = seasonalSeries(36)
    const points = forecast(series, 6)

    expect(points).toHaveLength(6)
    expect(points.map(p => p.index)).toEqual([1, 2, 3, 4, 5, 6])

    for (const point of points) {
      expect(Number.isNaN(point.point)).toBe(false)
      expect(Number.isNaN(point.lo)).toBe(false)
      expect(Number.isNaN(point.hi)).toBe(false)
      expect(Number.isFinite(point.point)).toBe(true)
      expect(point.point).toBeGreaterThanOrEqual(0)
      expect(point.lo).toBeGreaterThanOrEqual(0)
      expect(point.lo).toBeLessThanOrEqual(point.point)
      expect(point.point).toBeLessThanOrEqual(point.hi)
      // Two decimals, like every other money value in the app.
      expect(round2(point.point)).toBe(point.point)
      expect(round2(point.lo)).toBe(point.lo)
      expect(round2(point.hi)).toBe(point.hi)
    }

    // The forecast has to stay in the neighbourhood of the history it came from.
    const lastYear = series.slice(-12)
    const low = Math.min(...lastYear)
    const high = Math.max(...lastYear)
    for (const point of points) {
      expect(point.point).toBeGreaterThan(low * 0.75)
      expect(point.point).toBeLessThan(high * 1.35)
    }
  })

  it('learns the December spike rather than a flat line', () => {
    // The history ends at t = 35 (a December), so a 12-month horizon lands on
    // the next December at index 12 — the peak of SEASONAL_OFFSETS.
    const points = forecast(seasonalSeries(36), 12)
    const peak = points.reduce((best, point) => (point.point > best.point ? point : best))
    expect(peak.index).toBe(12)
    // February is the dip, two months out from a December.
    expect(points[1].point).toBeLessThan(points[0].point)
  })

  it('widens the band by the residual spread and keeps lo <= point <= hi', () => {
    const points = forecast(seasonalSeries(36), 6)
    for (const point of points) {
      expect(point.hi - point.point).toBeGreaterThan(0)
      expect(point.point - point.lo).toBeGreaterThan(0)
    }
    // The band is a constant width, not a fan (see the forecast() header).
    const widths = points.map(point => round2(point.hi - point.lo))
    expect(new Set(widths).size).toBe(1)
  })

  it('falls back gracefully on a short series', () => {
    const points = forecast([1200, 1350, 1180, 1420, 1500], 3)
    expect(points).toHaveLength(3)
    for (const point of points) {
      expect(Number.isFinite(point.point)).toBe(true)
      expect(point.point).toBeGreaterThan(0)
      expect(point.lo).toBeLessThanOrEqual(point.point)
      expect(point.point).toBeLessThanOrEqual(point.hi)
    }
    // A two-point history can only repeat itself.
    expect(forecast([1200, 1350], 2).map(p => p.point)).toEqual([1350, 1350])
  })

  it('returns an empty result for an empty series instead of throwing', () => {
    expect(forecast([], 6)).toEqual([])
    expect(forecast([], 0)).toEqual([])
  })

  it('returns an empty result for a non-positive or nonsense horizon', () => {
    const series = seasonalSeries(36)
    expect(forecast(series, 0)).toEqual([])
    expect(forecast(series, -3)).toEqual([])
    expect(forecast(series, Number.NaN)).toEqual([])
  })

  it('never forecasts a negative month, even for a collapsing series', () => {
    const falling = Array.from({ length: 30 }, (_value, index) => Math.max(0, 5000 - 220 * index))
    const points = forecast(falling, 6)
    expect(points).toHaveLength(6)
    for (const point of points) {
      expect(point.point).toBeGreaterThanOrEqual(0)
      expect(point.lo).toBeGreaterThanOrEqual(0)
      expect(point.lo).toBeLessThanOrEqual(point.point)
      expect(point.point).toBeLessThanOrEqual(point.hi)
    }
  })

  it('survives a series full of NaN', () => {
    const points = forecast([Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN], 3)
    expect(points).toHaveLength(3)
    expect(points.every(point => Number.isFinite(point.point))).toBe(true)
  })
})

describe('forecast — planTrip', () => {
  it('says yes with room to spare when free cash comfortably covers it', () => {
    const plan = planTrip({
      targetAmount: 3000,
      monthsUntil: 6,
      avgMonthlyTotal: 4200,
      forecastMonthlyTotal: 3400,
      people: 2,
    })
    expect(plan.requiredMonthly).toBe(500)
    expect(plan.perPersonMonthly).toBe(250)
    expect(plan.freeCashMonthly).toBe(800)
    expect(plan.feasible).toBe(true)
    expect(plan.verdict).toContain('CHF 500.00')
    expect(plan.verdict).toContain('CHF 250.00')
  })

  it('says doable-but-snug when the margin is thin', () => {
    const plan = planTrip({
      targetAmount: 3000,
      monthsUntil: 6,
      avgMonthlyTotal: 4200,
      forecastMonthlyTotal: 3650,
    })
    expect(plan.feasible).toBe(true)
    expect(plan.freeCashMonthly).toBe(550)
    expect(plan.verdict).toMatch(/snug/i)
  })

  it('says how many months it would take when the target is out of reach', () => {
    const plan = planTrip({
      targetAmount: 6000,
      monthsUntil: 6,
      avgMonthlyTotal: 4200,
      forecastMonthlyTotal: 3900,
    })
    expect(plan.requiredMonthly).toBe(1000)
    expect(plan.freeCashMonthly).toBe(300)
    expect(plan.feasible).toBe(false)
    // 6000 / 300 = 20 months at the current rate.
    expect(plan.verdict).toContain('20 months')
    expect(plan.verdict).toContain('CHF 700.00')
  })

  it('says there is nothing spare when the forecast exceeds the average', () => {
    const plan = planTrip({
      targetAmount: 2000,
      monthsUntil: 4,
      avgMonthlyTotal: 3000,
      forecastMonthlyTotal: 3400,
    })
    expect(plan.freeCashMonthly).toBe(-400)
    expect(plan.feasible).toBe(false)
    expect(plan.verdict).toMatch(/no free cash/i)
    // The verdict never prints a minus sign at the reader.
    expect(plan.verdict).not.toContain('-')
  })

  it('treats a zero target as already paid for', () => {
    const plan = planTrip({
      targetAmount: 0,
      monthsUntil: 3,
      avgMonthlyTotal: 3000,
      forecastMonthlyTotal: 2000,
    })
    expect(plan.requiredMonthly).toBe(0)
    expect(plan.perPersonMonthly).toBe(0)
    expect(plan.feasible).toBe(true)
    expect(plan.verdict).toMatch(/already paid for/i)
  })

  it('honours a non-default currency', () => {
    const plan = planTrip({
      targetAmount: 1200,
      monthsUntil: 4,
      avgMonthlyTotal: 3000,
      forecastMonthlyTotal: 2000,
      currency: 'EUR',
    })
    expect(plan.verdict).toContain('EUR 300.00')
    expect(plan.verdict).not.toContain('CHF')
  })

  it('cannot be made to throw by degenerate input', () => {
    const plan = planTrip({
      targetAmount: Number.NaN,
      monthsUntil: 0,
      avgMonthlyTotal: Number.NaN,
      forecastMonthlyTotal: Number.POSITIVE_INFINITY,
      currency: '',
    })
    expect(Number.isFinite(plan.requiredMonthly)).toBe(true)
    expect(Number.isFinite(plan.freeCashMonthly)).toBe(true)
    expect(typeof plan.verdict).toBe('string')
    expect(plan.verdict.length).toBeGreaterThan(0)
  })

  it('rounds a fractional monthly instalment to two decimals', () => {
    const plan = planTrip({
      targetAmount: 1000,
      monthsUntil: 3,
      avgMonthlyTotal: 2000,
      forecastMonthlyTotal: 1000,
      people: 2,
    })
    expect(plan.requiredMonthly).toBe(333.33)
    expect(plan.perPersonMonthly).toBe(166.67)
  })
})

/* ----------------------------------------------------------------- images */

/** A flat-colour bitmap of the requested size, encoded with the requested codec. */
async function makeImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' = 'jpeg',
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 236, g: 233, b: 226 } },
  })
  return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer()
}

describe('images — input validation', () => {
  it('recognises the image types a phone or a scanner produces', () => {
    expect(isSupportedImageType('image/jpeg')).toBe(true)
    expect(isSupportedImageType('image/JPG; charset=binary')).toBe(true)
    expect(isSupportedImageType('image/heic')).toBe(true)
    expect(isSupportedImageType('application/pdf')).toBe(false)
    expect(isSupportedImageType('text/plain')).toBe(false)
  })

  it('rejects a non-image mime type', async () => {
    const error = await processReceiptImage(
      Buffer.from('%PDF-1.7 not a receipt'),
      'application/pdf',
    )
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ImageError)
    expect((error as ImageError).code).toBe('unsupported_type')
  })

  it('rejects an upload over 10 MB without trying to decode it', async () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41)
    const error = await processReceiptImage(oversized, 'image/jpeg')
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ImageError)
    expect((error as ImageError).code).toBe('too_large')
    expect((error as ImageError).message).toContain(String(MAX_UPLOAD_BYTES))
  })

  it('accepts an upload of exactly the limit — the ceiling is > , not >=', async () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    // Exactly at the limit must get past the size guard and fail on the *bytes*
    // instead; an off-by-one in `assertWithinSizeLimit` would say 'too_large'.
    const atTheLimit = Buffer.alloc(MAX_UPLOAD_BYTES, 0x41)
    const error = await processReceiptImage(atTheLimit, 'image/jpeg')
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect((error as ImageError).code).toBe('decode_failed')
  })

  it('rejects an empty upload and undecodable bytes', async () => {
    await expect(processReceiptImage(Buffer.alloc(0), 'image/jpeg')).rejects.toMatchObject({
      code: 'decode_failed',
    })
    await expect(
      processReceiptImage(Buffer.from('this is definitely not an image'), 'image/jpeg'),
    ).rejects.toMatchObject({ code: 'decode_failed' })
  })

  it('never puts image bytes into the error message', async () => {
    const error = await processReceiptImage(Buffer.from('secret-bytes'), 'image/jpeg')
      .then(() => null)
      .catch((caught: unknown) => caught)
    expect((error as Error).message).not.toContain('secret-bytes')
  })
})

describe('images — processReceiptImage', () => {
  it('downscales a 3000 px image to 2000 px on the long edge', async () => {
    const wide = await makeImage(3000, 1500)
    const processed = await processReceiptImage(wide, 'image/jpeg')
    expect(processed.width).toBe(MAX_LONG_EDGE)
    expect(processed.height).toBe(1000)
  })

  it('caps the long edge of a portrait photo too', async () => {
    const tall = await makeImage(900, 3000, 'png')
    const processed = await processReceiptImage(tall, 'image/png')
    expect(processed.height).toBe(MAX_LONG_EDGE)
    expect(processed.width).toBe(600)
  })

  it('does NOT upscale a small image', async () => {
    const small = await makeImage(400, 600, 'png')
    const processed = await processReceiptImage(small, 'image/png')
    expect(processed.width).toBe(400)
    expect(processed.height).toBe(600)
  })

  it('returns a real JPEG whatever went in', async () => {
    const png = await makeImage(800, 600, 'png')
    const processed = await processReceiptImage(png, 'image/png')
    // SOI marker: every JPEG starts FF D8 FF.
    expect([...processed.buffer.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    const meta = await sharp(processed.buffer).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(800)
    expect(meta.height).toBe(600)
    expect(processed.bytes).toBe(processed.buffer.byteLength)
  })

  it('strips EXIF, including the orientation flag it has already applied', async () => {
    // A 3:2 landscape photo tagged "rotate 90°" must come out 2:3 with no EXIF.
    const rotated = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 10, g: 60, b: 120 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
    const processed = await processReceiptImage(rotated, 'image/jpeg')
    expect(processed.width).toBe(400)
    expect(processed.height).toBe(600)
    const meta = await sharp(processed.buffer).metadata()
    expect(meta.exif).toBeUndefined()
    expect(meta.orientation).toBeUndefined()
  })

  it('flattens transparency onto white, not onto black', async () => {
    const transparent = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()
    const processed = await processReceiptImage(transparent, 'image/png')
    const stats = await sharp(processed.buffer).stats()
    for (const channel of stats.channels) {
      expect(channel.mean).toBeGreaterThan(250)
    }
  })

  it('normalises mime-type aliases and parameters', async () => {
    const jpeg = await makeImage(500, 400)
    for (const mime of ['image/jpg', 'image/pjpeg', 'IMAGE/JPEG', 'image/jpeg; charset=binary']) {
      const processed = await processReceiptImage(jpeg, mime)
      expect(processed.width).toBe(500)
    }
  })
})

describe('images — thumbnail', () => {
  it('bounds a thumbnail by the default square and keeps the aspect ratio', async () => {
    const wide = await makeImage(3000, 1500)
    const thumb = await thumbnail(wide)
    expect(thumb.width).toBe(320)
    expect(thumb.height).toBe(160)
    expect((await sharp(thumb.buffer).metadata()).format).toBe('jpeg')
  })

  it('honours an explicit size and still never upscales', async () => {
    const small = await makeImage(400, 600, 'png')
    expect((await thumbnail(small, 100)).height).toBe(100)
    const tiny = await makeImage(50, 50, 'png')
    expect((await thumbnail(tiny, 320)).width).toBe(50)
  })

  it('falls back to the default size for a nonsense size', async () => {
    const wide = await makeImage(1000, 500)
    expect((await thumbnail(wide, Number.NaN)).width).toBe(320)
    expect((await thumbnail(wide, 0)).width).toBe(1)
  })

  it('is smaller than the full-size render of the same photo', async () => {
    const wide = await makeImage(3000, 1500)
    const full = await processReceiptImage(wide, 'image/jpeg')
    const thumb = await thumbnail(wide)
    expect(thumb.bytes).toBeLessThan(full.bytes)
  })
})
