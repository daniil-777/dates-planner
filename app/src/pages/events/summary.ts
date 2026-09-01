/**
 * The arithmetic behind the Events page.
 *
 * Two things are worth saying out loud, because the whole feature rests on them:
 *
 *  - **Nothing here is ever subtracted from anything.** An event has a total, a posting
 *    count and, per person, what that person paid. `share` is a proportion of the spend so a
 *    bar can be drawn; it is never a claim on anybody.
 *  - **The event total is a sum of what was posted**, not of what was budgeted or promised.
 *    A participant who never reached for their wallet still belongs on the roster with a
 *    zero — that is the difference between reporting and accusing.
 *
 * `eventTotals()` on the server (CONTRACTS.md §9) is the authority for one event's numbers.
 * `rollupByEvent` exists for the *list*, where calling a per-event function once per card
 * would mean one round trip per row; it derives the same two figures from postings the page
 * already has.
 */

import type { Event, Expense, Person } from '@/api/types'
import { DEFAULT_CURRENCY } from '@/theme'
import { lastDayOf, parseIsoDate } from './dates'

/** What a card needs to know about an event without asking the server a second time. */
export interface EventRollup {
  /** How many postings are booked on the event. */
  count: number
  /** What those postings add up to. */
  total: number
}

export const EMPTY_ROLLUP: EventRollup = { count: 0, total: 0 }

/**
 * Half-up to two decimals, matching `srv/lib/money.ts`.
 *
 * The 1e-9 nudge keeps a value that binary floating point stores just under the halfway
 * mark — 1.005 is really 1.00499999999999989 — from rounding the wrong way.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  const sign = value < 0 ? -1 : 1
  return (sign * Math.round(Math.abs(value) * 100 + 1e-9)) / 100
}

/**
 * Groups postings by the event they are booked on. Everyday spending — `event_ID` null —
 * belongs to no event and is left out entirely.
 *
 * Rounding happens once, on the finished sum, never on an intermediate.
 */
export function rollupByEvent(expenses: readonly Expense[]): Map<string, EventRollup> {
  const byEvent = new Map<string, EventRollup>()
  for (const expense of expenses) {
    const id = expense.event_ID
    if (!id) continue
    const running = byEvent.get(id)
    if (running) {
      running.count += 1
      running.total += expense.amount
    } else {
      byEvent.set(id, { count: 1, total: expense.amount })
    }
  }
  for (const rollup of byEvent.values()) rollup.total = roundMoney(rollup.total)
  return byEvent
}

/** Indexes any collection of entities by its `ID`, for the lookups a render pass needs. */
export function byId<T extends { ID: string }>(items: readonly T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const item of items) index.set(item.ID, item)
  return index
}

/**
 * A proportion of the total as whole percent.
 *
 * A share that is real but tiny reads as `<1%` rather than `0%`, so a person who paid for
 * one coffee on a two-thousand-franc trip is not shown as having paid for nothing.
 */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const percent = share * 100
  if (percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

/**
 * Width for a proportion bar.
 *
 * Clamped so a rounding artefact upstream cannot overflow the track, and cut to two decimals
 * so the inline style reads `64.65%` rather than the seventeen digits binary floating point
 * would otherwise write into the DOM.
 */
export function barWidth(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  return `${Math.min(100, Math.round(share * 10000) / 100)}%`
}

/** Most recent first, ties broken by name so the order never depends on fetch order. */
export function sortEvents(events: readonly Event[]): Event[] {
  return [...events].sort(
    (a, b) => b.startsOn.localeCompare(a.startsOn) || a.name.localeCompare(b.name),
  )
}

export interface EventSections {
  /** Running now or still to come, soonest first. */
  current: Event[]
  /** Finished, most recent first. */
  past: Event[]
}

/**
 * Divides the roster around today. An event counts as current until the end of its last day,
 * so the dinner you are at right now does not drop into the history section at breakfast.
 */
export function sectionEvents(events: readonly Event[], today: string): EventSections {
  const current: Event[] = []
  const past: Event[] = []
  for (const event of events) {
    if (!parseIsoDate(event.startsOn)) past.push(event)
    else if (lastDayOf(event.startsOn, event.endsOn) >= today) current.push(event)
    else past.push(event)
  }
  current.sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name))
  return { current, past: sortEvents(past) }
}

/**
 * `'Ada, Grace and 2 others'` — the roster in one line, for a card subtitle and for the
 * accessible name of the avatar row, which is otherwise a pile of unlabelled circles.
 */
export function participantLabel(people: readonly Person[]): string {
  const names = people.map(person => person.name).filter(name => name.length > 0)
  if (names.length === 0) return 'Nobody yet'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} ${rest === 1 ? 'other' : 'others'}`
}

/** `'3 postings'`, `'1 posting'`, `'No postings yet'`. */
export function postingsLabel(count: number): string {
  if (count <= 0) return 'No postings yet'
  return `${count} ${count === 1 ? 'posting' : 'postings'}`
}

/**
 * The currency to render an aggregate in.
 *
 * `Expenses.currency` is per posting, but a household books in one currency and the seed data
 * is entirely CHF; taking it from the postings rather than hardcoding it means a ledger kept
 * in euros reads correctly, and an empty event still has something to print.
 */
export function currencyOf(expenses: readonly Expense[]): string {
  return expenses.find(expense => Boolean(expense.currency))?.currency ?? DEFAULT_CURRENCY
}
