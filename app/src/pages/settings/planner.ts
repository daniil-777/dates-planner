/**
 * Pre-spend planner — "Lisbon in October?"
 *
 * A commitment approval, in the SAP sense: somebody wants to spend a sum on a date, and the
 * question is whether the run-rate the ledger already knows about can carry it. The facts
 * come from the backend — `monthlyTotals` over the last twelve months and the confirmed
 * postings behind them — and the arithmetic here turns them into the numbers a household
 * actually argues about: what has to go aside each month, who puts in what, and whether
 * that is realistic.
 *
 * There is no debt in this app, so a contribution here is an intention rather than a bill:
 * it is what each person plans to put aside, weighted either evenly or the way they have
 * actually been paying. There is no fixed number of people — two or nine come through the
 * same code.
 *
 * Everything is pure and every input is clamped. A target date in the year 9999 becomes a
 * ten-year horizon rather than a division that produces `0.00` a month and a verdict of
 * "approved", and a target of a hundred million becomes the ceiling rather than `Infinity`.
 */

import type { Expense, MonthlyTotal, Person } from '@/api/types'
import { formatMoney } from '@/theme'

/** Months of horizon the planner will consider. One is "this month"; ten years is plenty. */
export const MIN_HORIZON_MONTHS = 1
export const MAX_HORIZON_MONTHS = 120

/** Nobody is planning a two-franc trip, and nobody is planning a ten-million-franc one. */
export const MIN_TARGET = 1
export const MAX_TARGET = 1_000_000

/**
 * Categories a household can plausibly trim to fund something else. Groceries and Health
 * are not on the list on purpose: "spend less on medicine" is not a savings plan.
 */
export const DISCRETIONARY_CATEGORIES = [
  'Dining',
  'Cafes',
  'Entertainment',
  'Subscriptions',
  'Gifts',
  'Travel',
] as const

export type Verdict = 'approved' | 'conditional' | 'referred'

/** What one person has actually paid, as a proportion of everything paid. Never a claim. */
export interface PersonShare {
  personId: string
  name: string
  /** 0…1. Zero for somebody who has paid for nothing in the window. */
  share: number
}

export interface PlannerFacts {
  /** Distinct months the ledger has any confirmed spending in, within the window. */
  monthsObserved: number
  /** Average spend per observed month, all categories. */
  averageMonthly: number
  /** Average spend per observed month across `DISCRETIONARY_CATEGORIES`. */
  discretionaryMonthly: number
  /** Everybody on the roster, descending by what they have paid. */
  paidShares: PersonShare[]
  /** The window the facts were computed over, for the "simulation basis" line. */
  fromPeriod: string
  toPeriod: string
}

/** `equal` divides the set-aside evenly; `observed` weights it by what each has paid. */
export type ShareMode = 'equal' | 'observed'

export interface PlannerInput {
  target: number
  /** `YYYY-MM-DD`. */
  targetDate: string
  shareMode: ShareMode
  today?: Date
}

/** What one person puts aside per month under this plan. */
export interface Contribution {
  personId: string
  name: string
  amount: number
}

export interface PlanResult {
  horizonMonths: number
  /** What the date asked for before clamping; negative when the date has passed. */
  requestedMonths: number
  /** True when the requested date was outside 1…120 months and had to be pulled in. */
  clamped: boolean
  target: number
  monthlySetAside: number
  /** Adds up to `monthlySetAside` exactly; the last row absorbs the rounding. */
  perPerson: Contribution[]
  /** Required set-aside as a fraction of the observed discretionary run-rate. */
  coverage: number
  verdict: Verdict
  headline: string
  rationale: string
}

const VERDICT_HEADLINES: Record<Verdict, string> = {
  approved: 'Approved',
  conditional: 'Approved with conditions',
  referred: 'Referred for review',
}

export interface Horizon {
  /** What the plan uses: always between 1 and 120. */
  months: number
  /** What the date actually asked for — negative for a date in the past. */
  requested: number
  /** True when the request had to be pulled inside the allowed range. */
  clamped: boolean
}

/**
 * Whole months from this month to the target month, clamped to a sane horizon.
 *
 * A date this month or in the past is one month — you are paying for it now — and anything
 * past ten years is ten years, which is what stops an absurd date (a typo of `2926`, say)
 * from turning the required set-aside into rounding noise and the verdict into a rubber
 * stamp. The UI shows the clamp rather than hiding it.
 */
export function horizonMonths(targetDate: string, today: Date = new Date()): Horizon {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(targetDate.trim())
  if (!match) return { months: MIN_HORIZON_MONTHS, requested: MIN_HORIZON_MONTHS, clamped: false }

  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(year) || month < 1 || month > 12) {
    return { months: MIN_HORIZON_MONTHS, requested: MIN_HORIZON_MONTHS, clamped: false }
  }

  const requested = (year - today.getFullYear()) * 12 + (month - 1 - today.getMonth())
  const months = Math.min(MAX_HORIZON_MONTHS, Math.max(MIN_HORIZON_MONTHS, requested))
  return { months, requested, clamped: months !== requested }
}

/** Round half-up to two decimals, the way every amount in this app is rounded. */
function round2(value: number): number {
  return Math.round(value * 100 + 1e-9) / 100
}

function clampTarget(target: number): number {
  if (!Number.isFinite(target)) return MIN_TARGET
  return Math.min(MAX_TARGET, Math.max(MIN_TARGET, round2(target)))
}

/**
 * Divide the monthly set-aside between the people on the roster.
 *
 * `observed` needs somebody to have paid something; with an empty ledger every share is
 * zero and the honest fallback is an even division rather than a row of `0.00`. Rounding
 * happens once per person and the last row takes the remainder, so the parts always add up
 * to the whole — a set-aside that is one rappen short of itself is a support ticket.
 */
function distribute(
  monthly: number,
  people: readonly PersonShare[],
  mode: ShareMode,
): Contribution[] {
  if (people.length === 0) return []

  const total = people.reduce(
    (sum, person) => sum + (Number.isFinite(person.share) ? Math.max(0, person.share) : 0),
    0,
  )
  const weighted = mode === 'observed' && total > 0

  const amounts = people.map(person =>
    round2(monthly * (weighted ? Math.max(0, person.share) / total : 1 / people.length)),
  )
  const drift = round2(monthly - amounts.reduce((sum, amount) => sum + amount, 0))
  amounts[amounts.length - 1] = round2(amounts[amounts.length - 1] + drift)

  return people.map((person, index) => ({
    personId: person.personId,
    name: person.name,
    amount: amounts[index],
  }))
}

/**
 * The verdict.
 *
 * The yardstick is the discretionary run-rate rather than income, which this app has never
 * been told: if the monthly set-aside is under half of what the household already spends
 * on dinners, coffee, subscriptions and gifts, it is affordable by redirection alone.
 * Up to all of it is possible but means giving those up. Beyond that the honest answer is
 * that the date or the number has to move.
 */
export function planSpend(input: PlannerInput, facts: PlannerFacts): PlanResult {
  const target = clampTarget(input.target)
  const { months, requested, clamped } = horizonMonths(input.targetDate, input.today ?? new Date())
  const monthly = round2(target / months)

  const perPerson = distribute(monthly, facts.paidShares, input.shareMode)

  const discretionary = facts.discretionaryMonthly
  const coverage = discretionary > 0 ? monthly / discretionary : Number.POSITIVE_INFINITY

  let verdict: Verdict
  let rationale: string

  if (facts.monthsObserved === 0) {
    verdict = 'referred'
    rationale =
      'There are no confirmed postings to plan against yet. Post a month of expenses and ' +
      'the simulation has something to stand on.'
  } else if (coverage <= 0.5) {
    verdict = 'approved'
    rationale =
      `The set-aside is ${percent(coverage)} of the ${money(discretionary)} a month that ` +
      'currently goes on dining, coffee, subscriptions and the like. It fits without anyone ' +
      'noticing.'
  } else if (coverage <= 1) {
    verdict = 'conditional'
    rationale =
      `The set-aside is ${percent(coverage)} of the discretionary run-rate of ` +
      `${money(discretionary)} a month. It is affordable, but most of the eating out has ` +
      'to become cooking in.'
  } else {
    verdict = 'referred'
    rationale =
      discretionary > 0
        ? `The set-aside is ${percent(coverage)} of the ${money(discretionary)} a month ` +
          'currently spent on things that could be given up. Move the date out or the ' +
          'number down.'
        : 'There is no discretionary spending on record to redirect, so this would have to ' +
          'come out of something the ledger has not seen.'
  }

  return {
    horizonMonths: months,
    requestedMonths: requested,
    clamped,
    target,
    monthlySetAside: monthly,
    perPerson,
    coverage,
    verdict,
    headline: VERDICT_HEADLINES[verdict],
    rationale,
  }
}

function percent(ratio: number): string {
  if (!Number.isFinite(ratio)) return 'more than all'
  return `${Math.round(ratio * 100)}%`
}

/**
 * Money inside a generated sentence.
 *
 * `formatMoney` from `theme.ts` is the single implementation of Swiss formatting in this
 * app (FRONTEND-CONTRACT §5) — prose is not an excuse to write a second one.
 */
function money(amount: number): string {
  return formatMoney(amount)
}

/* ------------------------------------------------------------------ *
 *  Facts, from what the backend already knows
 * ------------------------------------------------------------------ */

/**
 * Turn `monthlyTotals` and the confirmed postings into the planner's inputs.
 *
 * `monthlyTotals` is period × category and already excludes drafts, which makes it exactly
 * the run-rate. Who paid cannot come from it — it has no person dimension — so that part is
 * derived from the expenses themselves. Everybody on the roster appears, including the
 * people who have paid for nothing: a roster, not a leaderboard.
 */
export function derivePlannerFacts(
  totals: MonthlyTotal[],
  expenses: Expense[],
  people: Person[],
  fromPeriod: string,
  toPeriod: string,
): PlannerFacts {
  const months = new Set<string>()
  let overall = 0
  let discretionary = 0
  const trimmable = new Set<string>(DISCRETIONARY_CATEGORIES)

  for (const row of totals) {
    if (!Number.isFinite(row.total)) continue
    months.add(row.period)
    overall += row.total
    if (trimmable.has(row.category)) discretionary += row.total
  }

  const monthsObserved = months.size

  const paid = new Map<string, number>(people.map(person => [person.ID, 0]))
  let paidTotal = 0
  for (const expense of expenses) {
    if (expense.status !== 'confirmed') continue
    if (expense.date < `${fromPeriod}-01` || expense.date > `${toPeriod}-31`) continue
    if (!Number.isFinite(expense.amount)) continue
    if (expense.paidBy_ID === null || !paid.has(expense.paidBy_ID)) continue
    paid.set(expense.paidBy_ID, (paid.get(expense.paidBy_ID) ?? 0) + expense.amount)
    paidTotal += expense.amount
  }

  const paidShares: PersonShare[] = people
    .map(person => ({
      personId: person.ID,
      name: person.name,
      share: paidTotal > 0 ? (paid.get(person.ID) ?? 0) / paidTotal : 0,
    }))
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))

  return {
    monthsObserved,
    averageMonthly: monthsObserved === 0 ? 0 : round2(overall / monthsObserved),
    discretionaryMonthly: monthsObserved === 0 ? 0 : round2(discretionary / monthsObserved),
    paidShares,
    fromPeriod,
    toPeriod,
  }
}

/**
 * A sensible first target date: the first of the month, twelve months out.
 *
 * Lisbon in October is the example in the card, but the card should open on something
 * plausible rather than on the example.
 */
export function defaultTargetDate(today: Date = new Date()): string {
  const year = today.getFullYear() + 1
  const month = String(today.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}-01`
}
