/**
 * Client-side mirror of `srv/lib/settlement.ts` (CONTRACTS.md §9).
 *
 * There is no debt in this app. Everything here is a *sum*: what the month came to, and what each
 * person paid out of it. `share` is a proportion of the month's spend — the width of a bar,
 * never a claim on anyone.
 *
 * The server stays authoritative; `usePeriodTotals(period)` is what the cards render. These
 * functions fill that in while the query is in flight and power the preview inside the
 * period-close dialog, so the numbers on screen agree with the clearing document that comes
 * back from the run.
 */
import type { Expense, PeriodTotals, Person, PersonTotal } from '@/api/types'

/** One posting, reduced to only what the arithmetic needs (CONTRACTS.md §9). */
export interface TotalsInput {
  amount: number
  /** `null` when nobody has been assigned to the posting yet. */
  paidById: string | null
  /** `null` for everyday spending that belongs to no event. */
  eventId: string | null
  /** `YYYY-MM-DD`. */
  date: string
}

export const toTotalsInput = (expense: Expense): TotalsInput => ({
  amount: expense.amount,
  paidById: expense.paidBy_ID,
  eventId: expense.event_ID,
  date: expense.date,
})

/** Half-up to 2 decimals, applied once at the end of a calculation and never in between. */
function roundMoney(value: number): number {
  const scaled = Math.abs(value) * 100
  const rounded = Math.round(scaled + Number.EPSILON * scaled) / 100
  return value < 0 ? -rounded : rounded
}

/** A proportion of the total, 0..1. A month that cost nothing gives 0, never `NaN`. */
function shareOf(paid: number, grandTotal: number): number {
  return grandTotal > 0 ? paid / grandTotal : 0
}

/** Biggest payer first; ties fall back to the name so the order never flickers. */
const byPaidThenName = (a: PersonTotal, b: PersonTotal): number =>
  b.paid - a.paid || a.name.localeCompare(b.name)

/**
 * What `period` came to, and who paid it.
 *
 * Every person on the roster gets a row, including one who paid nothing this month.
 * A posting nobody has been assigned to still counts toward `grandTotal` — the money left
 * the household either way — it simply lands under no name.
 */
export function summarisePeriod(
  rows: readonly TotalsInput[],
  period: string,
  people: readonly Pick<Person, 'ID' | 'name'>[],
): PeriodTotals {
  const paid = new Map<string, number>()
  const counts = new Map<string, number>()
  let total = 0
  let count = 0

  for (const row of rows) {
    if (!row.date.startsWith(period)) continue
    total += row.amount
    count += 1
    if (!row.paidById) continue
    paid.set(row.paidById, (paid.get(row.paidById) ?? 0) + row.amount)
    counts.set(row.paidById, (counts.get(row.paidById) ?? 0) + 1)
  }

  const grandTotal = roundMoney(total)
  const byPerson = people
    .map(person => {
      const personPaid = roundMoney(paid.get(person.ID) ?? 0)
      return {
        personId: person.ID,
        name: person.name,
        paid: personPaid,
        count: counts.get(person.ID) ?? 0,
        share: shareOf(personPaid, grandTotal),
      }
    })
    .sort(byPaidThenName)

  return { period, grandTotal, count, byPerson }
}

/**
 * The roster the "who paid" card draws: one row per person, whatever the server sent back.
 *
 * Somebody who paid nothing is still part of the month, so they get a row with `paid: 0`
 * rather than being dropped — and somebody who paid but has since been removed from the
 * roster keeps their row, because the money is on the books regardless.
 */
export function rosterTotals(totals: PeriodTotals, people: readonly Person[]): PersonTotal[] {
  const scored = new Map(totals.byPerson.map(entry => [entry.personId, entry]))
  const onRoster = new Set(people.map(person => person.ID))

  const rows: PersonTotal[] = people.map(
    person =>
      scored.get(person.ID) ?? {
        personId: person.ID,
        name: person.name,
        paid: 0,
        count: 0,
        share: 0,
      },
  )
  for (const entry of totals.byPerson) {
    if (!onRoster.has(entry.personId)) rows.push(entry)
  }
  return rows.sort(byPaidThenName)
}

/** What a period close is about to record, worked out before anybody presses the button. */
export interface ClosePreview {
  period: string
  /** Everything posted in the month, drafts included — what the period cost. */
  grandTotal: number
  /** Verified postings not yet on a clearing document: the ones the close will stamp. */
  postings: number
  /** Their total. */
  postingsTotal: number
  /** Drafts still waiting for review. They are left out of the close. */
  drafts: number
  /** Postings already carrying an earlier clearing document. */
  alreadyClosed: number
}

/** Summarise the month a period close would stamp. Moves nothing, decides nothing. */
export function previewClose(expenses: readonly Expense[], period: string): ClosePreview {
  let grandTotal = 0
  let postings = 0
  let postingsTotal = 0
  let drafts = 0
  let alreadyClosed = 0

  for (const expense of expenses) {
    if (!expense.date.startsWith(period)) continue
    grandTotal += expense.amount
    if (expense.status === 'draft') {
      drafts += 1
      continue
    }
    if (expense.settlement_ID) {
      alreadyClosed += 1
      continue
    }
    postings += 1
    postingsTotal += expense.amount
  }

  return {
    period,
    grandTotal: roundMoney(grandTotal),
    postings,
    postingsTotal: roundMoney(postingsTotal),
    drafts,
    alreadyClosed,
  }
}
