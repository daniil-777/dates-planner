/**
 * Money arithmetic — the one place in the backend where rounding is allowed to happen.
 *
 * CONTRACTS §9: "All money rounds half-up to 2 decimals at the **end** of the
 * calculation only." Three consequences this module exists to enforce:
 *
 * 1. Half-up means half **away from zero** (Java's `HALF_UP`, the commercial/SAP
 *    convention): `2.345 -> 2.35` and `-2.345 -> -2.35`. Plain `Math.round()` is
 *    wrong here because it breaks that symmetry (it rounds `-0.5` to `-0`).
 * 2. Intermediate values are carried as **integer cents**, so a chain of shares,
 *    halves and sums cannot drift (`0.1 + 0.2` must stay `0.30`, never
 *    `0.30000000000000004`).
 * 3. Rounding happens once, at the end. `sumMoney` therefore accumulates exact
 *    fractional cents and rounds the total, rather than rounding each addend.
 *
 * Amounts are stored as `Decimal(10,2)`, i.e. at most 8 integer digits, so every
 * value handled here fits comfortably inside `Number.MAX_SAFE_INTEGER` cents.
 */

/** Thrown for values that are not usable money — the caller passed garbage. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/** A Decimal(10,2) amount has two decimal places — one cent is 10^-2. */
const MONEY_DECIMALS = 2

/**
 * Multiply/divide by a power of ten without binary drift.
 *
 * WHY: `1.005 * 100` is `100.49999999999999` in IEEE-754, which would round down
 * and lose a rappen. Going through the shortest round-tripping decimal string and
 * moving the exponent instead (`"1.005" + "e2"` -> `100.5`) gives the value a
 * human would expect, because the parse is a correctly-rounded decimal-to-double
 * conversion of the *shifted decimal*, not of a product of two doubles.
 */
function shiftDecimal(value: number, places: number): number {
  const parts = value.toString().split('e')
  const exponent = parts.length > 1 ? Number(parts[1]) : 0
  return Number(`${parts[0]}e${exponent + places}`)
}

/** Guards the entry points so a NaN can never be laundered into an amount. */
function requireFinite(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError(`${what} must be a finite number, got ${String(value)}`)
  }
  return value
}

/** Half-up (away from zero) rounding of an already-scaled value. */
function roundHalfUp(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value)
  // -0 is a valid double but an ugly thing to store or compare; normalise it away.
  return rounded === 0 ? 0 : rounded
}

/**
 * Convert an amount to whole cents, rounding half-up.
 *
 * WHY: this is the boundary between "money as the user typed it" and the integer
 * domain where all our arithmetic is exact.
 */
export function toCents(amount: number): number {
  const cents = roundHalfUp(shiftDecimal(requireFinite(amount, 'amount'), MONEY_DECIMALS))
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`amount ${amount} is outside the range money can represent exactly`)
  }
  return cents
}

/**
 * Convert cents back to an amount with 2 decimals.
 *
 * Fractional cents are rounded half-up rather than rejected, so that the common
 * `fromCents(toCents(x) / 2)` stays legal: this function is the intended single
 * rounding point at the end of a calculation.
 */
export function fromCents(cents: number): number {
  const whole = roundHalfUp(requireFinite(cents, 'cents'))
  if (!Number.isSafeInteger(whole)) {
    throw new MoneyError(`${cents} cents is outside the range money can represent exactly`)
  }
  return shiftDecimal(whole, -MONEY_DECIMALS)
}

/** Round an amount half-up to 2 decimals — the final step of any money calculation. */
export function round2(amount: number): number {
  return fromCents(toCents(amount))
}

/**
 * Sum amounts with a single rounding at the end (CONTRACTS §9).
 *
 * WHY not `values.reduce((a, b) => a + b)`: adding doubles accumulates drift, and
 * rounding each addend first would round twice. Summing exact cents does neither.
 * An empty list sums to 0 — a total of nothing is nothing, not an error.
 */
export function sumMoney(values: readonly number[]): number {
  let cents = 0
  for (const value of values) {
    cents += shiftDecimal(requireFinite(value, 'amount'), MONEY_DECIMALS)
  }
  return fromCents(cents)
}

const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * Read a CDS `Decimal` into a number.
 *
 * WHY: depending on the database driver (and on whether the value came from a
 * SELECT, an OData payload or a CSV seed) a `Decimal(10,2)` arrives as a JS number
 * *or* as a string like `"148.50"`. Every consumer would otherwise have to guess.
 * Garbage — null, undefined, objects, `"abc"`, `"1,50"` — throws instead of
 * silently becoming NaN and poisoning a total.
 */
export function toAmount(value: unknown): number {
  if (typeof value === 'number') {
    return requireFinite(value, 'amount')
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new MoneyError(`amount ${value.toString()} is too large to convert exactly`)
    }
    return Number(value)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '' || !DECIMAL_STRING.test(text)) {
      throw new MoneyError(`amount ${JSON.stringify(value)} is not a decimal number`)
    }
    return requireFinite(Number(text), 'amount')
  }
  throw new MoneyError(`amount must be a number or a decimal string, got ${typeof value}`)
}
