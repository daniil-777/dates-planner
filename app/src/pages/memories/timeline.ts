/**
 * Turns the two backing collections — Memories and the Expenses whose moment
 * was worth remembering — into one ordered timeline.
 *
 * An expense that already has a memory written up does not get its own entry:
 * the memory absorbs it and inherits its amount, so a date night appears once,
 * with its story and its bill together.
 */

import type { Expense, Memory, MemoryKind, MomentCode, Photo } from '@/api/types'
import { monthLabel, parseIsoDate, periodOf } from './dates'

/** The moments that earn a place on the timeline. */
export const MEMORABLE_MOMENTS = ['date_night', 'trip', 'gift'] as const
export type MemorableMoment = (typeof MEMORABLE_MOMENTS)[number]

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'date_night',
  'trip',
  'gift',
  'anniversary',
  'other',
]

export function isMemorableMoment(moment: MomentCode | null): moment is MemorableMoment {
  return moment === 'date_night' || moment === 'trip' || moment === 'gift'
}

export interface TimelineEntry {
  /** Stable across renders; also the DOM id the map scrolls to. */
  key: string
  source: 'memory' | 'expense'
  memoryID: string | null
  expenseID: string | null
  title: string
  /** `YYYY-MM-DD`. */
  date: string
  kind: MemoryKind
  pinned: boolean
  note: string | null
  place: string | null
  lat: number | null
  lon: number | null
  amount: number | null
  currency: string
  photos: Photo[]
  /** The first date. Gets the `#1` badge and the receipt reveal. */
  isDocumentOne: boolean
}

export interface MonthGroup {
  period: string
  label: string
  entries: TimelineEntry[]
}

const KIND_LABELS: Record<MemoryKind, string> = {
  date_night: 'Date night',
  trip: 'Trip',
  gift: 'Gift',
  anniversary: 'Anniversary',
  other: 'Moment',
}

const KIND_ICONS: Record<MemoryKind, string> = {
  date_night: 'heart',
  trip: 'flight',
  gift: 'present',
  anniversary: 'favorite',
  other: 'appointment',
}

export function kindLabel(kind: MemoryKind): string {
  return KIND_LABELS[kind] ?? KIND_LABELS.other
}

export function kindIcon(kind: MemoryKind): string {
  return KIND_ICONS[kind] ?? KIND_ICONS.other
}

export function domIdForKey(key: string): string {
  return `memory-entry-${key}`
}

export function entryDomId(entry: TimelineEntry): string {
  return domIdForKey(entry.key)
}

/** `MIGROS ZUERICH HB` reads better as `Migros Zuerich Hb` on a love letter. */
export function titleFromExpense(expense: Expense): string {
  const raw = (expense.merchantRaw ?? '').trim()
  if (!raw) return kindLabel(momentToKind(expense.moment))
  if (raw !== raw.toUpperCase()) return raw
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map(word => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function momentToKind(moment: MomentCode | null): MemoryKind {
  return isMemorableMoment(moment) ? moment : 'other'
}

export function noteExcerpt(note: string | null, max = 180): string {
  if (!note) return ''
  const flat = note.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

function entryFromMemory(memory: Memory, expense: Expense | undefined): TimelineEntry {
  return {
    key: `m-${memory.ID}`,
    source: 'memory',
    memoryID: memory.ID,
    expenseID: memory.expense_ID ?? expense?.ID ?? null,
    title: memory.title || kindLabel(memory.kind),
    date: memory.occurredOn ?? expense?.date ?? '',
    kind: memory.kind ?? 'other',
    pinned: Boolean(memory.pinned),
    note: memory.note ?? null,
    place: memory.place ?? expense?.place ?? null,
    lat: memory.lat ?? expense?.lat ?? null,
    lon: memory.lon ?? expense?.lon ?? null,
    amount: expense ? expense.amount : null,
    currency: expense?.currency ?? 'CHF',
    photos: memory.photos ?? [],
    isDocumentOne: expense?.documentNumber === 1,
  }
}

function entryFromExpense(expense: Expense): TimelineEntry {
  return {
    key: `e-${expense.ID}`,
    source: 'expense',
    memoryID: null,
    expenseID: expense.ID,
    title: titleFromExpense(expense),
    date: expense.date,
    kind: momentToKind(expense.moment),
    pinned: false,
    note: expense.note ?? null,
    place: expense.place,
    lat: expense.lat,
    lon: expense.lon,
    amount: expense.amount,
    currency: expense.currency ?? 'CHF',
    photos: [],
    isDocumentOne: expense.documentNumber === 1,
  }
}

/**
 * Pinned first, then newest first. Ties fall back to title and key so two
 * memories on the same day never swap places between renders.
 */
export function sortTimelineEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
  })
}

/** The whole timeline, sorted, with linked expenses folded into their memory. */
export function buildTimeline(
  memories: readonly Memory[],
  expenses: readonly Expense[],
): TimelineEntry[] {
  const expenseById = new Map(expenses.map(expense => [expense.ID, expense]))
  const claimed = new Set<string>()

  const entries: TimelineEntry[] = []
  for (const memory of memories) {
    const linked = memory.expense_ID ? expenseById.get(memory.expense_ID) : undefined
    if (linked) claimed.add(linked.ID)
    entries.push(entryFromMemory(memory, linked))
  }

  for (const expense of expenses) {
    if (claimed.has(expense.ID)) continue
    if (!isMemorableMoment(expense.moment)) continue
    if (!parseIsoDate(expense.date)) continue
    entries.push(entryFromExpense(expense))
  }

  return sortTimelineEntries(entries)
}

export function splitPinned(entries: readonly TimelineEntry[]): {
  pinned: TimelineEntry[]
  rest: TimelineEntry[]
} {
  const sorted = sortTimelineEntries(entries)
  return {
    pinned: sorted.filter(entry => entry.pinned),
    rest: sorted.filter(entry => !entry.pinned),
  }
}

export function groupByMonth(entries: readonly TimelineEntry[]): MonthGroup[] {
  const groups = new Map<string, TimelineEntry[]>()
  for (const entry of entries) {
    const period = periodOf(entry.date) || 'unknown'
    const bucket = groups.get(period)
    if (bucket) bucket.push(entry)
    else groups.set(period, [entry])
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([period, items]) => ({
      period,
      label: period === 'unknown' ? 'Undated' : monthLabel(period),
      entries: items,
    }))
}

/**
 * Memorable expenses nobody has written up yet — the "New memories detected"
 * strip. Recent only, because a nudge about a dinner from two years ago is
 * nagging rather than romantic.
 */
export function undocumentedExpenses(
  memories: readonly Memory[],
  expenses: readonly Expense[],
  today: string,
  opts: { withinDays?: number; limit?: number } = {},
): Expense[] {
  const withinDays = opts.withinDays ?? 120
  const limit = opts.limit ?? 8
  const claimed = new Set(
    memories.map(memory => memory.expense_ID).filter((id): id is string => Boolean(id)),
  )
  return expenses
    .filter(expense => isMemorableMoment(expense.moment))
    .filter(expense => !claimed.has(expense.ID))
    .filter(expense => Boolean(parseIsoDate(expense.date)))
    .filter(expense => daysAgo(expense.date, today) <= withinDays)
    .sort((a, b) => (a.date === b.date ? a.ID.localeCompare(b.ID) : a.date < b.date ? 1 : -1))
    .slice(0, limit)
}

function daysAgo(date: string, today: string): number {
  const a = parseIsoDate(date)
  const b = parseIsoDate(today)
  if (!a || !b) return Number.POSITIVE_INFINITY
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000)
}

/** Entries the map can actually pin. */
export function locatableEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return entries.filter(
    entry =>
      typeof entry.lat === 'number' &&
      typeof entry.lon === 'number' &&
      Number.isFinite(entry.lat) &&
      Number.isFinite(entry.lon),
  )
}
