/**
 * Design tokens and the formatting rules everything else in the app defers to.
 *
 * The important one is `formatMoney`. It is a byte-for-byte port of `money()` in
 * `srv/lib/llm/template.ts`, because the yearly statement is rendered by the backend and
 * shown by the frontend: if the two disagree about thousands separators, the same number
 * appears twice on one screen in two different shapes. Swiss format, ASCII apostrophe,
 * symbol first, sign in front of everything — `CHF 18'420.55`, `-CHF 30.52`.
 *
 * `Intl`/`toLocaleString` is deliberately not used: its `de-CH` output uses U+2019 in some
 * runtimes and U+0027 in others, and its `en` default gives `18,420.55`.
 */

import type { MemoryKind, MomentCode } from './api/types'

/** CONTRACTS.md §1.4 — mirrored here so a page never invents its own threshold. */
export const NEEDS_REVIEW_THRESHOLD = 0.6

export const DEFAULT_CURRENCY = 'CHF'

/** CONTRACTS.md §1.2, in the order the moment picker offers them. */
export const MOMENT_CODES: readonly MomentCode[] = ['everyday', 'date_night', 'trip', 'gift']

/** Display strings for the four moment codes. */
export const MOMENT_LABELS: Record<MomentCode, string> = {
  everyday: 'Everyday',
  date_night: 'Date night',
  trip: 'Trip',
  gift: 'Gift',
}

/** SAP icons that carry each moment. All four exist in the SAP-icons collection. */
export const MOMENT_ICONS: Record<MomentCode, string> = {
  everyday: 'home',
  date_night: 'heart',
  trip: 'flight',
  gift: 'present',
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  date_night: 'Date night',
  trip: 'Trip',
  gift: 'Gift',
  anniversary: 'Anniversary',
  other: 'Other',
}

/**
 * `db/data/twowaymatch-Categories.csv` names four icons that the installed SAP-icons
 * collection does not ship (`cup`, `gift`, `heartbeat`, `subscription`). Rather than edit
 * seed data that CONTRACTS.md §1.1 pins, map them to the nearest icon that does exist —
 * an unknown name renders as an empty box and logs a warning on every paint.
 */
const ICON_ALIASES: Record<string, string> = {
  cup: 'nutrition-activity',
  gift: 'present',
  heartbeat: 'electrocardiogram',
  subscription: 'refresh',
}

/** Resolves a data-driven icon name to one the icon collection actually has. */
export function resolveIcon(name: string | null | undefined, fallback = 'receipt'): string {
  if (!name) return fallback
  return ICON_ALIASES[name] ?? name
}

/* ------------------------------------------------------------------ *
 *  Money
 * ------------------------------------------------------------------ */

/**
 * Swiss money, identical to the backend's renderer.
 *
 * ```
 * formatMoney(18420.55)          // "CHF 18'420.55"
 * formatMoney(-30.52)            // "-CHF 30.52"
 * formatMoney(1234.5, 'EUR')     // "EUR 1'234.50"
 * ```
 */
function groupedMagnitude(amount: number): string {
  // The 1e-9 nudge keeps 1.005 from rounding down through binary float representation.
  const rounded = Math.round(Math.abs(amount) * 100 + 1e-9) / 100
  const [whole, fraction] = rounded.toFixed(2).split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${fraction}`
}

export function formatMoney(amount: number, currency: string = DEFAULT_CURRENCY): string {
  const safe = Number.isFinite(amount) ? amount : 0
  return `${safe < 0 ? '-' : ''}${currency} ${groupedMagnitude(safe)}`
}

/** The amount without its currency, for tight table cells: `18'420.55`, `-30.52`. */
export function formatAmount(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0
  return `${safe < 0 ? '-' : ''}${groupedMagnitude(safe)}`
}

/** `0.9871` → `'99%'`. Confidences are shown as whole percent everywhere. */
export function formatConfidence(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return '—'
  return `${Math.round(confidence * 100)}%`
}

/* ------------------------------------------------------------------ *
 *  Dates
 * ------------------------------------------------------------------ */

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
]

const MONTHS_LONG = [
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
]

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_ONLY_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * `'2024-06-15'` → `'15 Jun 2024'`.
 *
 * A bare `YYYY-MM-DD` is split by hand rather than fed to `new Date`, which would read it
 * as UTC midnight and render the day before for anyone west of Greenwich.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'

  const dateOnly = DATE_ONLY_RE.exec(value)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    return `${Number(day)} ${MONTHS_SHORT[Number(month) - 1] ?? month} ${year}`
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${parsed.getDate()} ${MONTHS_SHORT[parsed.getMonth()]} ${parsed.getFullYear()}`
}

/** `'19:30:00'` → `'19:30'`. Anything unparseable comes back untouched. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return ''
  const match = TIME_ONLY_RE.exec(value)
  if (match) return `${match[1]}:${match[2]}`
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
}

/** `'2026-09-01T10:47:13.211Z'` → `'1 Sep 2026, 12:47'` in the reader's own timezone. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  if (DATE_ONLY_RE.test(value)) return formatDate(value)

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const hours = String(parsed.getHours()).padStart(2, '0')
  const minutes = String(parsed.getMinutes()).padStart(2, '0')
  return `${parsed.getDate()} ${MONTHS_SHORT[parsed.getMonth()]} ${parsed.getFullYear()}, ${hours}:${minutes}`
}

/** `'2026-01'` → `'January 2026'`. */
export function formatPeriod(period: string | null | undefined): string {
  if (!period) return '—'
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (!match) return period
  return `${MONTHS_LONG[Number(match[2]) - 1] ?? match[2]} ${match[1]}`
}

/** The current month as `YYYY-MM`, in local time — the same clock a period close uses. */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** `n` periods back from `period`, inclusive of the start: `shiftPeriod('2026-03', -2)` → `'2026-01'`. */
export function shiftPeriod(period: string, months: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (!match) return period
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + months, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ *
 *  Design tokens
 * ------------------------------------------------------------------ */

/**
 * Spacing, radii and surfaces. Colours are UI5 theme parameters rather than hex, so the
 * whole app follows `sap_horizon` → `sap_horizon_dark` without a second palette.
 */
export const tokens = {
  space: {
    xs: '0.25rem',
    s: '0.5rem',
    m: '0.75rem',
    l: '1rem',
    xl: '1.5rem',
    xxl: '2rem',
  },
  radius: {
    s: '0.5rem',
    m: '0.75rem',
    l: '1rem',
    pill: '999px',
  },
  /** The smallest thing a thumb should have to hit. */
  touchTarget: '44px',
  color: {
    brand: 'var(--sapBrandColor, #0070F2)',
    text: 'var(--sapTextColor, #1d2d3e)',
    textSubtle: 'var(--sapContent_LabelColor, #556b82)',
    background: 'var(--sapBackgroundColor, #f5f6f7)',
    surface: 'var(--sapTile_Background, #fff)',
    border: 'var(--sapList_BorderColor, #d9d9d9)',
    positive: 'var(--sapPositiveColor, #256f3a)',
    negative: 'var(--sapNegativeColor, #aa0808)',
    critical: 'var(--sapCriticalColor, #e76500)',
  },
  shadow: {
    card: 'var(--sapContent_Shadow0, 0 0 0.125rem rgba(34, 54, 73, 0.32))',
    raised: 'var(--sapContent_Shadow1, 0 0.125rem 0.5rem rgba(34, 54, 73, 0.2))',
  },
  /** Above this width the shell shows side navigation instead of a bottom bar. */
  desktopBreakpoint: 1024,
} as const

export type Tokens = typeof tokens
