/**
 * Totals and period closes — CONTRACTS.md §9.
 *
 * **Nobody owes anybody.** An expense records who *paid* it and, optionally,
 * which event it belongs to; everything this module produces is a sum, never a
 * balance. There is no netting here, no direction, and no arithmetic that could
 * be read as a claim on anyone — only "this is what was spent, and this is who
 * put it on their card".
 *
 * The module is pure: it takes rows the caller has already selected (per §9,
 * `status='confirmed'` and no `settlement`) and returns numbers. Nothing here
 * knows about CDS, so the monthly period close, the event page and the tests all
 * share one implementation.
 *
 * Three rules are easy to get subtly wrong, so each is stated once and enforced
 * in one place:
 *
 * 1. **The roster, not the spenders.** A person who paid nothing still gets a
 *    line with `paid: 0`. A period summary is a picture of the household, and
 *    silently dropping whoever had a quiet month is how a list of people turns
 *    back into a scoreboard.
 * 2. **`share` is a proportion, never a claim.** It is `paid / grandTotal`, the
 *    width of a bar in the UI. With nothing spent it is `0` — never `NaN`, which
 *    would render as an empty bar in one browser and `NaN%` in another.
 * 3. **Round once, at the end.** Amounts are carried exactly and handed to
 *    `srv/lib/money.ts`, which rounds half-up to 2 decimals a single time per
 *    figure. Rounding each row first turns two CHF 1.005 postings into CHF 2.02.
 */

import { periodOf } from './dates'
import { fromCents, sumMoney, toCents } from './money'

/** Thrown for arguments the arithmetic cannot make sense of — the caller passed garbage. */
export class SettlementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettlementError'
  }
}

/** One expense row, reduced to only what the arithmetic needs. */
export interface TotalsInput {
  amount: number
  /** `People.ID` of whoever actually paid. Not a claim on anybody else. */
  paidById: string
  /** `Events.ID`, or null for everyday spending. */
  eventId: string | null
  /** `YYYY-MM-DD`; the period window is on this column. */
  date: string
}

/** What one person contributed to a total. */
export interface PersonTotal {
  personId: string
  name: string
  /** What this person actually paid out. */
  paid: number
  /** How many postings they paid for. */
  count: number
  /** `paid / grandTotal`, 0..1 — a proportion of the spend, NOT a debt. */
  share: number
}

/** One month of the ledger, as the period close freezes it. */
export interface PeriodTotals {
  /** `YYYY-MM`. */
  period: string
  grandTotal: number
  /** The whole roster, descending by `paid`, then by name. */
  byPerson: PersonTotal[]
  count: number
}

/** One trip, dinner or party, and what it came to. */
export interface EventTotals {
  eventId: string
  name: string
  grandTotal: number
  /** `grandTotal / participantCount`, shown as context ("CHF 540 each"), never as an amount owed. */
  perHead: number
  participantCount: number
  /** The participants, descending by `paid`, then by name. */
  byPerson: PersonTotal[]
  count: number
}

/** How a person reaches this module: the two columns the totals actually read. */
interface PersonRef {
  ID: string
  name: string
}

/** `YYYY-MM`, with a real month number — `2026-13` is not a period. */
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/

/** The rows that survived the window, folded into what both summaries need. */
interface Tally {
  /** Every amount in the window, unrounded — `money.ts` rounds the sum once. */
  amounts: number[]
  /** Payer id → the amounts they paid, unrounded, for the same reason. */
  byPayer: Map<string, number[]>
  count: number
}

/**
 * Total one month (CONTRACTS.md §9).
 *
 * `rows` may be the whole ledger: the window is applied here, on `date`, so the
 * caller cannot accidentally report June's spending as May's by forgetting a
 * `where`. Passing exactly the period's rows is therefore also correct — the
 * filter is a no-op on them.
 *
 * `people` is the roster to report on, and it is the *only* thing that decides
 * who gets a line. A posting whose payer is not on it (a person deleted after
 * the fact) still counts toward `grandTotal` and `count`, because the money was
 * genuinely spent, but it is not filed under a stranger's id.
 */
export function summarisePeriod(
  rows: readonly TotalsInput[],
  period: string,
  people: readonly PersonRef[],
): PeriodTotals {
  const window = requirePeriod(period)
  const roster = rosterOf(people, 'people')
  const counted = tallyRows(rows, (row, index) => periodOfRow(row, index) === window)
  const grandTotal = sumMoney(counted.amounts)

  return {
    period: window,
    grandTotal,
    byPerson: personTotals(roster, counted, grandTotal),
    count: counted.count,
  }
}

/**
 * Total one event over the people who were on it (CONTRACTS.md §9).
 *
 * `participants` is the roster for this event, which is generally a *subset* of
 * the household plus whoever came along — so the same rows summarised by period
 * and by event legitimately produce different lines. As in
 * {@link summarisePeriod}, somebody who paid for something on the trip without
 * being listed on it still counts toward the event's total.
 */
export function summariseEvent(
  rows: readonly TotalsInput[],
  event: { ID: string; name: string },
  participants: readonly PersonRef[],
): EventTotals {
  if (event === null || typeof event !== 'object') {
    throw new SettlementError(`event must be an { ID, name }, got ${JSON.stringify(event)}`)
  }
  const eventId = requireId(event.ID, 'event.ID')
  const roster = rosterOf(participants, 'participants')
  const counted = tallyRows(rows, row => row.eventId === eventId)
  const grandTotal = sumMoney(counted.amounts)
  const participantCount = roster.size

  return {
    eventId,
    name: trimmed(event.name),
    grandTotal,
    // Nobody divides into nothing: an event with no participants yet reports 0
    // rather than Infinity or NaN, both of which reach the UI as a broken tile.
    perHead: participantCount === 0 ? 0 : fromCents(toCents(grandTotal) / participantCount),
    participantCount,
    byPerson: personTotals(roster, counted, grandTotal),
    count: counted.count,
  }
}

/**
 * One line per person on the roster, whether or not they spent anything.
 *
 * `share` is computed in cents from the two figures that are actually reported,
 * so the bars in the UI add up to the total printed above them. `grandTotal` is
 * already rounded at this point, which is what makes `toCents` here exact rather
 * than a second rounding.
 */
function personTotals(
  roster: Map<string, string>,
  counted: Tally,
  grandTotal: number,
): PersonTotal[] {
  const totalCents = toCents(grandTotal)
  const totals: PersonTotal[] = []

  for (const [personId, name] of roster) {
    const amounts = counted.byPayer.get(personId) ?? []
    const paid = sumMoney(amounts)
    totals.push({
      personId,
      name,
      paid,
      count: amounts.length,
      share: totalCents === 0 ? 0 : toCents(paid) / totalCents,
    })
  }

  return totals.sort((left, right) => right.paid - left.paid || compareText(left.name, right.name))
}

/**
 * Fold the rows that pass `keep` into a {@link Tally}.
 *
 * Amounts are kept as given — a list per payer rather than a running sum —
 * because `sumMoney()` rounds a whole list once, and adding rounded rows is the
 * one mistake §9 spells out.
 */
function tallyRows(
  rows: readonly TotalsInput[],
  keep: (row: TotalsInput, index: number) => boolean,
): Tally {
  if (!Array.isArray(rows)) {
    throw new SettlementError(`rows must be a list of expense rows, got ${typeof rows}`)
  }
  const counted: Tally = { amounts: [], byPayer: new Map(), count: 0 }

  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== 'object') {
      throw new SettlementError(`row ${index} is not an expense row`)
    }
    if (!keep(row, index)) continue

    const amount = requireAmount(row.amount, index)
    counted.amounts.push(amount)
    counted.count += 1

    // An unattributed row (no payer, or a payer since deleted) keeps its money
    // in the total and simply matches nobody on the roster.
    const payer = typeof row.paidById === 'string' ? row.paidById.trim() : ''
    const paid = counted.byPayer.get(payer)
    if (paid === undefined) counted.byPayer.set(payer, [amount])
    else paid.push(amount)
  }

  return counted
}

/**
 * The roster, in the caller's order, id → display name.
 *
 * A Map because listing the same person twice must not divide their spend
 * between two half-empty lines; the first mention wins, and the sort in
 * {@link personTotals} decides the order that is actually shown.
 */
function rosterOf(people: readonly PersonRef[], what: string): Map<string, string> {
  if (!Array.isArray(people)) {
    throw new SettlementError(`${what} must be a list of people, got ${typeof people}`)
  }
  const roster = new Map<string, string>()

  for (const [index, person] of people.entries()) {
    if (person === null || typeof person !== 'object') {
      throw new SettlementError(`${what}[${index}] is not a person`)
    }
    const id = requireId(person.ID, `${what}[${index}].ID`)
    if (!roster.has(id)) roster.set(id, trimmed(person.name))
  }

  return roster
}

/** The period a row falls in, blaming the row rather than the date parser. */
function periodOfRow(row: TotalsInput, index: number): string {
  try {
    return periodOf(row.date)
  } catch {
    throw new SettlementError(
      `row ${index}: date must be YYYY-MM-DD, got ${JSON.stringify(row.date)}`,
    )
  }
}

function requirePeriod(period: string): string {
  const window = typeof period === 'string' ? period.trim() : ''
  if (!PERIOD.test(window)) {
    throw new SettlementError(`period must be YYYY-MM, got ${JSON.stringify(period)}`)
  }
  return window
}

function requireId(value: string, what: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (id.length === 0) {
    throw new SettlementError(`${what} must be a non-empty id, got ${JSON.stringify(value)}`)
  }
  return id
}

function requireAmount(amount: number, index: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new SettlementError(`row ${index}: amount must be a finite number, got ${String(amount)}`)
  }
  return amount
}

/** A name is display text: blank and absent mean the same thing. */
function trimmed(value: string): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Locale-independent ordering, so the same roster sorts the same on every machine. */
function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
