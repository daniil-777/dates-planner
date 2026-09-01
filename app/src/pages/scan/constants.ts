/**
 * Scan-flow constants. The cross-cutting ones (threshold, currency, moment
 * vocabulary) live in `theme.ts` and are re-exported here so this folder has a
 * single import site — they are never redefined.
 */

export { DEFAULT_CURRENCY, MOMENT_CODES, MOMENT_LABELS, NEEDS_REVIEW_THRESHOLD } from '../../theme'

/** The backend rejects anything larger; we downscale long before we get there. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Long edge the backend normalises to anyway — do it here so the upload stays small. */
export const MAX_LONG_EDGE = 2000

export const JPEG_QUALITY = 0.85

export const CURRENCY_CODES = ['CHF', 'EUR', 'USD', 'GBP'] as const
