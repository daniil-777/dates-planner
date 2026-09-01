/**
 * What is coming, in one list — FRONTEND-CONTRACT §8's "next-up strip".
 *
 * Three streams arrive here and leave as one: the reminders and events the service already
 * flattens into `upcoming()` (CONTRACTS §11, and the calendar's only read), and the yearly
 * recurrences the Memories page computes — Document #1 among them, which is the one date
 * this whole ledger is built around.
 *
 * No new calendar arithmetic is written here. `diffInDays`/`parseIsoDate` come from the
 * Events page's date helpers and `computeAnniversaries` from the Memories page's; the
 * launcher is a reader of both features, not a third implementation of them.
 */

import type { CalendarEntry, Expense, Memory } from '@/api/types'
import { diffInDays, formatDay, parseIsoDate, toIsoDate } from '../events/dates'
import type { Anniversary, AnniversarySeed } from '../memories/anniversaries'
import { daysUntilLabel, ordinal } from '../memories/dates'

/**
 * How far ahead the launcher looks. Long enough that a trip booked for next season is
 * already on the strip, short enough that "next up" still means something.
 */
export const NEXT_UP_HORIZON_DAYS = 90

export type NextUpKind = 'reminder' | 'event' | 'anniversary'

export interface NextUpItem {
  /** Stable across renders and unique within a list — a React key, and a test handle. */
  key: string
  kind: NextUpKind
  title: string
  /** 'YYYY-MM-DD' — the day this lands on. */
  date: string
  /** 0 is today. Never negative. */
  daysUntil: number
  /** One line of context under the title, or null when there is nothing worth adding. */
  detail: string | null
  /** Where tapping it goes. */
  to: string
  /** CONTRACTS §11.3 — a surprise only the person asking can see. */
  onlyYou: boolean
  /** A multi-day event that has already started. */
  running: boolean
}

/** Reminders first on a tie: a nudge exists precisely to be acted on before the thing it names. */
const KIND_ORDER: Record<NextUpKind, number> = { reminder: 0, event: 1, anniversary: 2 }

/**
 * `iso` shifted by whole days.
 *
 * Both operands are built through `Date.UTC` from an already-parsed triple, so the local
 * timezone cancels out — the trap `new Date('2026-09-01')` falls into is a day-early date
 * for every reader west of Greenwich.
 */
export function addIsoDays(iso: string, days: number): string {
  const ymd = parseIsoDate(iso)
  if (!ymd) return iso
  const shifted = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days))
  return toIsoDate({
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  })
}

/**
 * The dates worth remembering a year later: Document #1 (`Expenses.documentNumber = 1`,
 * CONTRACTS §10) and every pinned memory. Exactly the seeds the Memories page uses, so the
 * two screens never disagree about when an anniversary falls.
 */
export function anniversarySeeds(
  expenses: readonly Expense[],
  memories: readonly Memory[],
): AnniversarySeed[] {
  const seeds: AnniversarySeed[] = []

  const documentOne = expenses.find(expense => expense.documentNumber === 1)
  if (documentOne) {
    seeds.push({
      ID: documentOne.ID,
      title: 'Document #1',
      occurredOn: documentOne.date,
      source: 'document-one',
      place: documentOne.place,
    })
  }

  for (const memory of memories) {
    if (!memory.pinned) continue
    seeds.push({
      ID: memory.ID,
      title: memory.title,
      occurredOn: memory.occurredOn,
      source: 'memory',
      place: memory.place,
    })
  }

  return seeds
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`
}

function joinDetail(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part !== '')
  return kept.length > 0 ? kept.join(' · ') : null
}

function eventDetail(entry: CalendarEntry, running: boolean): string | null {
  const runsPast = entry.endsOn !== null && entry.endsOn > entry.date
  return joinDetail([
    entry.place,
    runsPast ? `${running ? 'until' : 'through'} ${formatDay(entry.endsOn)}` : null,
  ])
}

function reminderDetail(entry: CalendarEntry): string | null {
  const lead = entry.leadDays
  if (lead === null) return entry.place
  return joinDetail([
    lead === 0 ? 'on the day it starts' : `${plural(lead, 'day')} before it starts`,
    entry.place,
  ])
}

function itemFromEntry(entry: CalendarEntry, today: string): NextUpItem | null {
  if (entry.kind === 'reminder' && entry.done === true) return null
  if (!parseIsoDate(entry.date)) return null

  const daysUntil = Math.max(0, diffInDays(today, entry.date))
  const running =
    entry.kind === 'event' &&
    entry.date <= today &&
    entry.endsOn !== null &&
    entry.endsOn >= today &&
    entry.endsOn > entry.date

  return {
    key: `${entry.kind}:${entry.ID}`,
    kind: entry.kind,
    title: entry.title,
    date: entry.date,
    daysUntil,
    detail: entry.kind === 'reminder' ? reminderDetail(entry) : eventDetail(entry, running),
    to: entry.eventId ? `/events/${entry.eventId}` : '/calendar',
    onlyYou: entry.onlyYou,
    running,
  }
}

function itemFromAnniversary(anniversary: Anniversary): NextUpItem {
  return {
    key: `anniversary:${anniversary.ID}`,
    kind: 'anniversary',
    title: anniversary.title,
    date: anniversary.nextDate,
    daysUntil: anniversary.daysUntil,
    detail: joinDetail([`${ordinal(anniversary.years)} anniversary`, anniversary.place ?? null]),
    to: '/memories',
    onlyYou: false,
    running: false,
  }
}

export interface NextUpInput {
  /** Rows from `upcoming(from, to)`. Already free of other people's surprises. */
  entries: readonly CalendarEntry[]
  anniversaries: readonly Anniversary[]
  /** 'YYYY-MM-DD', local wall-clock. */
  today: string
  /** How many to keep. The strip shows one prominently and the rest underneath. */
  limit?: number
  horizonDays?: number
}

/**
 * The nearest few things, soonest first.
 *
 * Two details the service's shape forces. A multi-day event arrives **once per day it
 * covers**, every row carrying the same `ID`, so rows are collapsed to the earliest day —
 * a trip that started yesterday belongs on the strip as "on now", not five times. And a
 * reminder already ticked off is not upcoming at all, whatever its date says.
 */
export function buildNextUp({
  entries,
  anniversaries,
  today,
  limit = 3,
  horizonDays = NEXT_UP_HORIZON_DAYS,
}: NextUpInput): NextUpItem[] {
  const byKey = new Map<string, NextUpItem>()

  for (const entry of entries) {
    const item = itemFromEntry(entry, today)
    if (!item) continue
    if (item.daysUntil > horizonDays) continue
    const existing = byKey.get(item.key)
    // The earliest day an event covers is the one that reads as its date.
    if (!existing || item.date < existing.date) byKey.set(item.key, item)
  }

  for (const anniversary of anniversaries) {
    if (anniversary.daysUntil > horizonDays) continue
    const item = itemFromAnniversary(anniversary)
    if (!byKey.has(item.key)) byKey.set(item.key, item)
  }

  const items = [...byKey.values()].sort((a, b) => {
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    return a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
  })

  return items.slice(0, Math.max(0, limit))
}

/** `'On now'`, `'Today'`, `'Tomorrow'`, `'in 12 days'`. */
export function countdownLabel(item: NextUpItem): string {
  if (item.running) return 'On now'
  return daysUntilLabel(item.daysUntil)
}

/** The word for the kind, as the strip's little chip prints it. */
export const KIND_LABELS: Record<NextUpKind, string> = {
  reminder: 'Reminder',
  event: 'Event',
  anniversary: 'Anniversary',
}

/** The icon each kind carries — all registered in `./icons`. */
export const KIND_ICONS: Record<NextUpKind, string> = {
  reminder: 'bell',
  event: 'appointment-2',
  anniversary: 'present',
}
