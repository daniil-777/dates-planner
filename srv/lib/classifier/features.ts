/**
 * Featurisation — the TypeScript half of CONTRACTS §2, line-for-line with `ml/features.py`.
 *
 * Everything here exists twice, once in Python for training and once here for
 * inference, and `test/classifier-parity.test.ts` fails the build when the two
 * drift. That constraint explains the shape of this file:
 *
 * - **No library does any of this.** A tokenizer, a hasher or a date parser
 *   pulled from npm would have its own edge cases and none of them would be the
 *   ones scikit-learn and CPython have.
 * - **Python's regex dialect is emulated, not approximated.** `re` runs in
 *   Unicode mode by default, so `\b`, `\d` and `\s` there mean different sets
 *   than the same escapes mean in JavaScript. Step 4 of `normaliseMerchant`
 *   runs *before* non-ASCII characters are stripped, so those differences are
 *   reachable with a real merchant string ("KIOSK ØST 1234"), not just in
 *   theory. The classes below spell out what CPython actually matches.
 * - **The n-gram loop keeps a scikit-learn quirk on purpose.** See
 *   `charWbNgrams`.
 *
 * Do not "improve" a step here without changing `ml/features.py`, the contract
 * and the exported model together.
 */

import { parseWhenISO } from '../dates'
import { crc32Utf8 } from './crc32'

/**
 * Column order of the dense block — of the `StandardScaler` arrays, and of
 * `numericFeatures` in `weights.json` (CONTRACTS §2.4). Load-bearing: a model
 * exported against a different order would still score, just wrongly.
 */
export const NUMERIC_FEATURE_NAMES: readonly string[] = [
  'log_amount',
  'is_weekend',
  'is_evening',
  'hour_sin',
  'hour_cos',
  'dow_sin',
  'dow_cos',
]

export const N_NUMERIC = NUMERIC_FEATURE_NAMES.length

/** Default n-gram window, matching `CountVectorizer(ngram_range=(2, 4))`. */
export const N_GRAM_MIN = 2
export const N_GRAM_MAX = 4

/**
 * German transliteration runs *before* accent stripping so umlauts expand the
 * way a German speaker writes them ("zürich" → "zuerich"), which is also how
 * half of the bank statements already spell them. Stripping first would collapse
 * both spellings to "zurich" and lose the match against the spelled-out ones.
 */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
]

/**
 * What CPython's `\w` matches in Unicode mode: `str.isalnum()` plus underscore,
 * i.e. any letter, any numeric character, and `_`. JavaScript's `\b` is defined
 * against `[A-Za-z0-9_]` even under the `u` flag, so the boundaries below are
 * written as lookarounds over this class instead.
 */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/** CPython's `\d`: decimal digits only (category `Nd`), not every numeral. */
const DIGIT = '\\p{Nd}'

/**
 * CPython's `\s`: `Py_UNICODE_ISSPACE`. Differs from JavaScript's `\s` at both
 * ends — it includes the C1 file/group separators and NEL, and excludes U+FEFF.
 */
const SPACE =
  '[\\t\\n\\v\\f\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680' +
  '\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

/** `\b` in front of a word character, and `\b` behind one. */
const NOT_WORD_BEFORE = `(?<!${WORD_CHAR})`
const NOT_WORD_AFTER = `(?!${WORD_CHAR})`

/** Nonspacing marks — the combining accents left behind by NFKD. */
const COMBINING_MARKS = /\p{Mn}/gu

// CONTRACTS §2.1 step 4, applied in this order. Each deletes something that
// varies per transaction while the merchant stays the same, so that "COOP
// PRONTO NR. 4471" and "COOP PRONTO NR. 8829" become one merchant, not two.
const DATE_RE = new RegExp(
  `${NOT_WORD_BEFORE}${DIGIT}{1,2}[./-]${DIGIT}{1,2}[./-]${DIGIT}{2,4}${NOT_WORD_AFTER}`,
  'gu',
)
const TIME_RE = new RegExp(
  `${NOT_WORD_BEFORE}${DIGIT}{1,2}:${DIGIT}{2}(?::${DIGIT}{2})?${NOT_WORD_AFTER}`,
  'gu',
)
const REF_RE = new RegExp(
  `${NOT_WORD_BEFORE}(?:nr|no|ref|trx|tid|kd)[.:]?${SPACE}*${DIGIT}+${NOT_WORD_AFTER}`,
  'gu',
)
const LONG_DIGITS_RE = new RegExp(`${NOT_WORD_BEFORE}${DIGIT}{4,}${NOT_WORD_AFTER}`, 'gu')

/** Step 5: everything outside the surviving alphabet becomes a separator. */
const NON_TOKEN_RE = /[^a-z0-9 ]/gu

/** Step 6: collapse the separators the steps above left behind. */
const WHITESPACE_RE = new RegExp(`${SPACE}+`, 'gu')
const LEADING_SPACE_RE = new RegExp(`^${SPACE}+`, 'u')
const TRAILING_SPACE_RE = new RegExp(`${SPACE}+$`, 'u')

/**
 * Collapse a bank-statement descriptor to the stable part of the merchant name
 * (CONTRACTS §2.1).
 *
 * Statements bolt terminal ids, card numbers, booking dates and city suffixes
 * onto the same merchant, so the raw string is far too high-cardinality to learn
 * from. Everything that varies per transaction is deleted; everything that
 * identifies the shop survives.
 */
export function normaliseMerchant(raw: string): string {
  let text = raw.toLowerCase()
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    text = text.replace(pattern, replacement)
  }
  text = text.normalize('NFKD').replace(COMBINING_MARKS, '')
  text = text.replace(DATE_RE, ' ')
  text = text.replace(TIME_RE, ' ')
  text = text.replace(REF_RE, ' ')
  text = text.replace(LONG_DIGITS_RE, ' ')
  text = text.replace(NON_TOKEN_RE, ' ')
  return text
    .replace(WHITESPACE_RE, ' ')
    .replace(LEADING_SPACE_RE, '')
    .replace(TRAILING_SPACE_RE, '')
}

/**
 * Character n-grams inside word boundaries, byte-compatible with scikit-learn's
 * `analyzer='char_wb'` (CONTRACTS §2.2).
 *
 * Character n-grams beat word tokens here because merchant strings are riddled
 * with typos, abbreviations and glued-on suffixes; "migro" and "migros mm" still
 * share most of their grams. Padding each word with a space keeps prefixes and
 * suffixes distinguishable from infixes.
 *
 * The `break` is the part to read twice. `CountVectorizer._char_wb_ngrams` emits
 * a word shorter than the window **once**, for the first `n` that is too wide,
 * and then abandons the word entirely rather than trying wider windows. So `"a"`
 * (padded `" a "`, width 3) yields `[' a', 'a ', ' a ']` — at `n = 3` the whole
 * padded word is emitted and the loop stops, so `n = 4` never runs and `' a '`
 * appears exactly once. Emitting it again at `n = 4` would double that gram's
 * count and shift the L2 norm of every vector containing a one-letter word.
 */
export function charWbNgrams(text: string, nMin = N_GRAM_MIN, nMax = N_GRAM_MAX): string[] {
  const ngrams: string[] = []
  for (const word of text.split(' ')) {
    if (word.length === 0) continue
    const padded = ` ${word} `
    // Sliced by code point, not by UTF-16 unit, because Python indexes strings
    // by code point. The pipeline only ever feeds this `[a-z0-9 ]`, so the two
    // agree there anyway — but `charWbNgrams` is exported, and a caller handing
    // it an unnormalised string should get scikit-learn's answer, not a pair of
    // half-surrogates.
    const characters = Array.from(padded)
    const width = characters.length
    for (let n = nMin; n <= nMax; n += 1) {
      if (width <= n) {
        ngrams.push(padded)
        break
      }
      for (let offset = 0; offset + n <= width; offset += 1) {
        ngrams.push(characters.slice(offset, offset + n).join(''))
      }
    }
  }
  return ngrams
}

/**
 * Hash n-grams into a fixed-width sparse vector with no vocabulary to ship
 * (CONTRACTS §2.3).
 *
 * A learned vocabulary would have to be serialised into `weights.json` and kept
 * in sync with the Python trainer; CRC-32 is in both standard libraries, so
 * hashing keeps the exported artefact down to weights alone. Counts are
 * L2-normalised so a long merchant string does not simply out-shout a short one.
 *
 * The returned `Map` is keyed by bucket id and holds the normalised weights;
 * a zero norm (only reachable from an empty n-gram list) yields an empty map
 * rather than a vector of `NaN`.
 */
export function hashedNgramIds(ngrams: readonly string[], nBuckets: number): Map<number, number> {
  const counts = new Map<number, number>()
  for (const ngram of ngrams) {
    const bucket = crc32Utf8(ngram) % nBuckets
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  let sumOfSquares = 0
  for (const value of counts.values()) {
    sumOfSquares += value * value
  }
  const norm = Math.sqrt(sumOfSquares)
  if (norm === 0) return new Map<number, number>()
  for (const [bucket, value] of counts) {
    counts.set(bucket, value / norm)
  }
  return counts
}

/**
 * The whole text half of the pipeline in one call, so callers cannot mis-order
 * the three steps.
 */
export function textFeatures(raw: string, nBuckets: number): Map<number, number> {
  return hashedNgramIds(charWbNgrams(normaliseMerchant(raw)), nBuckets)
}

const TWO_PI = 2 * Math.PI

/**
 * The seven dense features in the exact contract order (CONTRACTS §2.4).
 *
 * Hour and weekday are encoded as sine/cosine pairs so 23:59 sits next to 00:01
 * for a linear model, while the blunt `is_weekend` / `is_evening` flags give it
 * the sharp threshold that "date night" actually depends on.
 *
 * `whenISO` is read as local wall-clock by `parseWhenISO` — "evening" is a human
 * fact, not a UTC one, and a date-only value means 12:00 so that imported bank
 * rows stay off the evening/weekend decision boundaries.
 */
export function numericFeatures(amount: number, whenISO: string): number[] {
  const when = parseWhenISO(whenISO)
  const hourOfDay = when.hour + when.minute / 60
  return [
    Math.log1p(Math.max(amount, 0)),
    when.dow >= 5 ? 1 : 0,
    when.hour >= 18 ? 1 : 0,
    Math.sin((TWO_PI * hourOfDay) / 24),
    Math.cos((TWO_PI * hourOfDay) / 24),
    Math.sin((TWO_PI * when.dow) / 7),
    Math.cos((TWO_PI * when.dow) / 7),
  ]
}
