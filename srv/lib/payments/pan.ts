/**
 * The card number guard — CONTRACTS.md §16.1.
 *
 * ## Why a whole file exists for something that should never happen
 *
 * The design of this subsystem is that a card number never reaches this process. The fields
 * belong to the payment provider, the browser posts them straight to the provider, and what
 * arrives here is a token. That is what keeps the app in the smallest PCI scope there is,
 * and it is not a detail — a PAN in a log file is a reportable incident, and a PAN in a
 * database backup makes every machine that backup ever touched part of the audit.
 *
 * Every implementation of this pattern says that. Very few of them *check*. The failure mode
 * is not the architecture being wrong, it is a well-meaning change six months later:
 * somebody adds a "card details" field to a support form, or widens a debug log to dump the
 * whole request body, or writes a mock that posts real fields to a real endpoint. None of
 * those look dangerous in review. All of them put a PAN on our side of the line.
 *
 * So the rule is enforced rather than documented. Every inbound payload on the payments
 * service is swept, and anything card-shaped is rejected at the door with the value never
 * being logged. It costs microseconds and it converts a class of silent, expensive mistakes
 * into a loud, cheap one.
 *
 * ## What "card-shaped" means here
 *
 * A run of 13–19 digits, ignoring the spaces and hyphens people actually type, that passes
 * the **Luhn check**. Luhn is the point: without it, this would reject order numbers,
 * timestamps in milliseconds, and phone numbers, and would be turned off within a week for
 * being noisy. With it, roughly nine in ten random digit runs of the right length are
 * dismissed, and the ones that survive are worth stopping for.
 *
 * It is deliberately *not* a brand-prefix check. Matching `4...` for Visa would miss every
 * card scheme this app has not heard of, and the guard's job is to be wrong in the safe
 * direction. A false positive here costs somebody a rephrased support message. A false
 * negative costs an audit.
 *
 * ## What it is not
 *
 * Not an anti-exfiltration control — anything determined to smuggle a number past it can
 * (base64, digits split across two fields). It is a guard against *accident*, which is the
 * threat that actually materialises. Treat a trip as a bug in the caller, not an attack.
 */

/** Length bounds from ISO/IEC 7812. Below 13 and above 19 nothing is a card. */
const MIN_PAN_DIGITS = 13
const MAX_PAN_DIGITS = 19

/** Digits, optionally grouped by single spaces or hyphens — how a person types a card. */
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g

/**
 * The Luhn checksum (ISO/IEC 7812-1 annex B).
 *
 * Doubling every second digit from the right, subtracting 9 from anything over 9, and
 * requiring the total to divide by ten. Every card scheme in use satisfies it, which is what
 * makes it a usable filter for "is this a card number" rather than "is this a long number".
 */
export function passesLuhn(digits: string): boolean {
  if (digits.length < MIN_PAN_DIGITS || digits.length > MAX_PAN_DIGITS) return false

  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const code = digits.charCodeAt(index) - 48
    if (code < 0 || code > 9) return false

    if (double) {
      const doubled = code * 2
      sum += doubled > 9 ? doubled - 9 : doubled
    } else {
      sum += code
    }
    double = !double
  }
  return sum % 10 === 0
}

/**
 * True when `value` contains something that could be a card number.
 *
 * Strings only. A caller holding a number rather than a string has already lost precision —
 * a 16-digit PAN exceeds `Number.MAX_SAFE_INTEGER` and cannot survive the round trip — so
 * there is nothing useful to check.
 */
export function looksLikePan(value: string): boolean {
  DIGIT_RUN.lastIndex = 0
  for (const match of value.matchAll(DIGIT_RUN)) {
    if (passesLuhn(match[0].replace(/[ -]/g, ''))) return true
  }
  return false
}

/**
 * The same value with every card-shaped run replaced by `[redacted-pan]`.
 *
 * For the one case where refusing is worse than sanitising: an error message on its way to a
 * log. Rejecting the request has already happened by then, and the message still has to say
 * *something* useful about where the value was.
 */
export function redactPan(value: string): string {
  return value.replace(DIGIT_RUN, run =>
    passesLuhn(run.replace(/[ -]/g, '')) ? '[redacted-pan]' : run,
  )
}

/**
 * Thrown when a payload carries something card-shaped.
 *
 * Carries the *path* to the offending value and never the value itself — an exception that
 * quotes what it found would put the number into every log that catches it, which is the
 * exact outcome this file exists to prevent.
 */
export class PanRejected extends Error {
  constructor(readonly path: string) {
    super(
      `A value at "${path}" looks like a card number. Card details must go to the payment ` +
        `provider from the browser and must never reach this server (CONTRACTS.md §16.1).`,
    )
    this.name = 'PanRejected'
  }
}

/** How deep to walk. Deeper than any real payload; stops a cyclic or hostile object. */
const MAX_DEPTH = 8

/**
 * Walk anything and throw on the first card-shaped string.
 *
 * Keys are checked as well as values. A payload posting `{ '4242424242424242': true }` is
 * every bit as much a leak as one posting it as a value, and an object built by pivoting a
 * form is how that happens by accident.
 */
export function assertNoPan(payload: unknown, path = '$'): void {
  walk(payload, path, 0, new WeakSet())
}

function walk(value: unknown, path: string, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_DEPTH) return

  if (typeof value === 'string') {
    if (looksLikePan(value)) throw new PanRejected(path)
    return
  }

  if (value === null || typeof value !== 'object') return

  // Cycles are rare in a parsed body and common in a CAP request object, which is the other
  // thing callers pass here.
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, seen))
    return
  }

  for (const [key, item] of Object.entries(value)) {
    if (looksLikePan(key)) throw new PanRejected(`${path}.<key>`)
    walk(item, `${path}.${key}`, depth + 1, seen)
  }
}
