/**
 * Turning one `upcoming(from, to)` answer into days.
 *
 * The service sends an event **once**, on the day it starts, carrying `endsOn`; a
 * four-day trip is one row, not four. A grid that dropped it into `entry.date` and
 * stopped would draw the Engadin trip on 27 December and leave 28, 29 and 30 blank,
 * which is exactly the week somebody is looking at when they ask "are we away then?".
 * So the expansion happens here, once, and both the grid and the list read the result.
 *
 * Two edges matter and both are covered below:
 *
 *  - An event that **started before the window** still arrives, dated outside it
 *    (asking for 28–31 December returns the trip with `date` 27 December). Its days
 *    are clamped to the window rather than dropped, and rather than trusted.
 *  - `CalendarEntry.ID` repeats across the days of one event, so a React key has to
 *    be the id *and* the day. `DayEntry.key` is that pair.
 */

import type { CalendarEntry, Reminder } from '@/api/types'
import { diffInDays, todayIso } from '../memories/dates'
import { addDays } from './grid'

/** One entry as it appears on one particular day. */
export interface DayEntry {
  entry: CalendarEntry
  /** `<row id>@<day>` — unique within a month, stable across renders. */
  key: string
  /** The day this instance is drawn on. */
  date: string
  /** True on the day a multi-day event actually starts. Always true for a reminder. */
  isFirstDay: boolean
  /** True on its last day. Both are true for a one-day event. */
  isLastDay: boolean
  /** How many days the event covers in total, both ends included. 1 for a reminder. */
  span: number
}

/** A day with something on it, in date order. */
export interface DayBucket {
  date: string
  items: DayEntry[]
}

/**
 * A trip longer than this is a sabbatical, not a weekend. The cap exists so a row
 * with a corrupt `endsOn` cannot spin the loop that draws it.
 */
const MAX_EVENT_DAYS = 400

/** Events first, then open reminders, then the ones already ticked off. */
function order(a: DayEntry, b: DayEntry): number {
  if (a.entry.kind !== b.entry.kind) return a.entry.kind === 'event' ? -1 : 1
  const aDone = a.entry.done === true
  const bDone = b.entry.done === true
  if (aDone !== bDone) return aDone ? 1 : -1
  return a.entry.title.localeCompare(b.entry.title) || a.entry.ID.localeCompare(b.entry.ID)
}

/**
 * Every day between `from` and `to` that carries something, keyed by `YYYY-MM-DD`.
 * A day with nothing on it is absent rather than present and empty.
 */
export function bucketEntries(
  entries: readonly CalendarEntry[],
  from: string,
  to: string,
): Map<string, DayEntry[]> {
  const byDay = new Map<string, DayEntry[]>()
  // `key` is `<row id>@<day>`, so this also makes the expansion idempotent: were the
  // service ever to start sending an event once per day it covers instead of once with
  // an `endsOn`, the same day would be produced twice and the second one dropped, rather
  // than the trip appearing four times on each of its four days.
  const seen = new Set<string>()

  const push = (date: string, item: DayEntry): void => {
    if (seen.has(item.key)) return
    seen.add(item.key)
    const existing = byDay.get(date)
    if (existing) existing.push(item)
    else byDay.set(date, [item])
  }

  for (const entry of entries) {
    if (!entry.date) continue

    const endsOn = entry.kind === 'event' ? (entry.endsOn ?? entry.date) : entry.date
    const lastDay = endsOn > entry.date ? endsOn : entry.date
    const span = Math.max(1, Math.min(diffInDays(entry.date, lastDay) + 1, MAX_EVENT_DAYS))

    // Clamped, not trusted: the row may reach into the window from either side.
    let day = entry.date < from ? from : entry.date
    const stop = lastDay > to ? to : lastDay
    for (let step = 0; day <= stop && step < MAX_EVENT_DAYS; step += 1) {
      push(day, {
        entry,
        key: `${entry.ID}@${day}`,
        date: day,
        isFirstDay: day === entry.date,
        isLastDay: day === lastDay,
        span,
      })
      day = addDays(day, 1)
    }
  }

  for (const items of byDay.values()) items.sort(order)
  return byDay
}

/** The same buckets as a list, earliest day first — what the list view walks. */
export function bucketsInOrder(byDay: ReadonlyMap<string, DayEntry[]>): DayBucket[] {
  return [...byDay.entries()]
    .map(([date, items]) => ({ date, items }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** What a day cell has to draw: how many dots, and whether one of them is a secret. */
export interface DayCounts {
  events: number
  reminders: number
  /** Reminders on this day that are not ticked off. */
  openReminders: number
  /** At least one entry is a surprise only this viewer can see. */
  onlyYou: boolean
}

const NO_COUNTS: DayCounts = { events: 0, reminders: 0, openReminders: 0, onlyYou: false }

export function countsOf(items: readonly DayEntry[] | undefined): DayCounts {
  if (!items || items.length === 0) return NO_COUNTS
  let events = 0
  let reminders = 0
  let openReminders = 0
  let onlyYou = false
  for (const item of items) {
    if (item.entry.kind === 'event') events += 1
    else {
      reminders += 1
      if (item.entry.done !== true) openReminders += 1
    }
    if (item.entry.onlyYou) onlyYou = true
  }
  return { events, reminders, openReminders, onlyYou }
}

/* ------------------------------------------------------------------ *
 *  The next-up strip
 * ------------------------------------------------------------------ */

export interface NextReminder {
  reminder: Reminder
  /** Whole days from today to `dueOn`. Negative when it has already slipped past. */
  daysUntil: number
  /** True when the nearest open reminder is one that was already due. */
  overdue: boolean
}

/**
 * The reminder the strip counts down to.
 *
 * A reminder that is still ahead always wins, however close an overdue one is: the
 * strip's job is "what is coming", and an overdue nudge is only shown when nothing
 * is. Ticked-off reminders never appear, and neither does one whose event could not
 * be read — without `dueOn` there is nothing to count down to.
 */
export function pickNextReminder(
  reminders: readonly Reminder[],
  today: string = todayIso(),
): NextReminder | null {
  let ahead: Reminder | null = null
  let behind: Reminder | null = null

  for (const reminder of reminders) {
    if (reminder.done) continue
    const dueOn = reminder.dueOn
    if (!dueOn) continue

    if (dueOn >= today) {
      if (sooner(reminder, ahead)) ahead = reminder
    } else if (moreRecent(reminder, behind)) {
      // The *most recently* missed one: the oldest is the least likely to still matter.
      behind = reminder
    }
  }

  const chosen = ahead ?? behind
  if (!chosen || !chosen.dueOn) return null
  return {
    reminder: chosen,
    daysUntil: diffInDays(today, chosen.dueOn),
    overdue: ahead === null,
  }
}

/** True when `candidate` is due before `current`, ties broken on id so the pick is stable. */
function sooner(candidate: Reminder, current: Reminder | null): boolean {
  if (!current) return true
  const a = candidate.dueOn ?? ''
  const b = current.dueOn ?? ''
  if (a !== b) return a < b
  return candidate.ID < current.ID
}

/** The overdue fallback picks the *latest* missed reminder; same stable tie-break. */
function moreRecent(candidate: Reminder, current: Reminder | null): boolean {
  if (!current) return true
  const a = candidate.dueOn ?? ''
  const b = current.dueOn ?? ''
  if (a !== b) return a > b
  return candidate.ID < current.ID
}

/** `'Today'`, `'Tomorrow'`, `'in 6 days'`, `'2 days ago'`. */
export function countdownLabel(daysUntil: number): string {
  if (daysUntil === 0) return 'Today'
  if (daysUntil === 1) return 'Tomorrow'
  if (daysUntil === -1) return 'Yesterday'
  if (daysUntil < 0) return `${Math.abs(daysUntil)} days ago`
  return `in ${daysUntil} days`
}

/** What a reminder is called when it has no note of its own: the event it points at. */
export function reminderTitle(reminder: Reminder): string {
  const note = reminder.note?.trim()
  if (note) return note
  return reminder.eventName ?? 'Reminder'
}

/** `'1 day before'`, `'on the day'` — how a lead time reads in a sentence. */
export function leadLabel(leadDays: number | null): string {
  if (leadDays === null || !Number.isFinite(leadDays) || leadDays <= 0) return 'on the day'
  return leadDays === 1 ? '1 day before' : `${leadDays} days before`
}
