/**
 * Points — CONTRACTS.md §17.2.
 *
 * A household earns points for the things this app exists to encourage, and can turn them
 * into something real. The whole design rests on one invariant, and it is a legal one rather
 * than a technical one, so it is worth stating before any of the numbers.
 *
 * ## The invariant: points are earned, never sold
 *
 * Electronically stored value becomes *e-money* — and issuing it becomes a licensed activity
 * — when it is "issued on receipt of funds". That phrase is the hinge. A points balance
 * somebody **bought** is money in a costume, whatever it is called in the UI, and issuing it
 * without an e-money licence is not a product decision. A points balance somebody **earned**
 * received no funds, and is therefore not e-money at all.
 *
 * So there is no way to buy points here. Not a top-up, not a bundle, not a subscription that
 * grants them, not a "convert your card balance into points". {@link EARN_RULES} is the
 * complete list of ways points come into existence and every one of them is an act, not a
 * payment. {@link assertEarnable} enforces it at the one place points are minted.
 *
 * That is why this is enforced in code rather than written in a policy document: the day
 * somebody adds "500 points for €5" to a growth experiment, it must fail a test, not pass
 * review.
 *
 * ## The other half: what points turn into
 *
 * Redeeming inside a limited range of goods and services is separately excluded from payment
 * services regulation, which covers rewards spent in the app and with partner places. Paying
 * a household out in cash is a rebate of our own money rather than the return of theirs,
 * which is an ordinary commercial arrangement — but it is the leg that accumulates toward
 * the €1,000,000-per-12-months notification threshold, so {@link REDEMPTION} carries the
 * counter that ADR-004 §7 says operations must watch.
 *
 * ## Why the double-entry ledger, for something that is not money
 *
 * Because an unbalanced points ledger is an infinite-points exploit, and points that can be
 * converted to anything real are worth attacking. Minting goes through the same balanced
 * transfer as everything else — out of a `treasury` account and into the household's — so
 * "how many points exist" is one query and can never disagree with itself.
 */
import { LedgerError, accountId, assertMoney, transfer, type Money, type Transfer } from './ledger'

/**
 * The currency code for points.
 *
 * Deliberately not an ISO code, and deliberately zero minor units — half a point is not a
 * thing, and letting one exist would put rounding into a balance people compare with each
 * other's.
 */
export const POINTS = 'PTS'

/** Where points come from. Never a person's account; points are minted, not moved. */
export const TREASURY = accountId('external', 'points-treasury')

/**
 * Everything that earns points.
 *
 * ## How the numbers were chosen
 *
 * Not by what each act is "worth" — there is no such quantity — but by what the app wants
 * more of, which is a different and more honest question.
 *
 * The largest single award is for **rating a place in the commons**, because that is the one
 * act that makes the app better for households other than the one performing it. A corpus
 * that nobody contributes to is worth nothing to anybody, and the cold-start problem is real:
 * the first thousand ratings are the expensive ones.
 *
 * The smallest are for the acts a household would do anyway. Scanning a receipt is worth a
 * little because it is a chore; recording an expense is worth almost nothing because it is
 * the point of the app.
 *
 * ## What is deliberately not here
 *
 * **Nothing pays out per franc spent.** Not one rule scales with an amount, and that is the
 * most important line in this file. A household app that awards points in proportion to
 * spending is an app that trains two people to spend more together and calls it a reward.
 * It would work — that is what makes it a dark pattern — and it is the exact opposite of
 * what a shared-expenses app is for. Points are for *acts*, never for *amounts*.
 *
 * **Nothing pays out for opening the app.** Streaks that punish a missed day turn a thing
 * people enjoy into a thing people owe, and the day it becomes an obligation is the day it
 * gets deleted.
 */
export const EARN_RULES = {
  /** A confirmed expense. Small: this is the app working, not an achievement. */
  expenseConfirmed: { points: 2, perDay: 10, label: 'Recorded an expense' },
  /** A receipt photographed and read. A chore, so it is worth a little more. */
  receiptScanned: { points: 5, perDay: 8, label: 'Scanned a receipt' },
  /** The big one. This is the act that helps strangers. */
  placeRated: { points: 40, perDay: 3, label: 'Rated a place for everyone' },
  /** A tip attached to a rating — the part other households actually read. */
  tipWritten: { points: 25, perDay: 3, label: 'Left a tip about a place' },
  /** A memory written up. The app's whole reason for existing, and rarely done. */
  memoryWritten: { points: 30, perDay: 4, label: 'Wrote up a memory' },
  /** An event planned in advance. Rewards intention rather than record-keeping. */
  eventPlanned: { points: 20, perDay: 3, label: 'Planned something together' },
  /** A round of the quiz finished. Deliberately modest — the game is its own reward. */
  gameFinished: { points: 10, perDay: 2, label: 'Finished a round of questions' },
  /** Closing a month. Once a month by nature, so it can be worth something. */
  periodClosed: { points: 100, perDay: 1, label: 'Closed the month' },
  /** Both people said how their day was. Rewards the pair, not the individual. */
  moodsBoth: { points: 8, perDay: 1, label: 'Both said how the day went' },
} as const

export type EarnReason = keyof typeof EARN_RULES

/**
 * What a household can turn points into.
 *
 * `rate` is points per minor unit of currency — 200 points to the franc, so the headline
 * awards above are worth something recognisable without being worth enough to farm. Rating
 * forty places is a coffee, which is about right for a thing that costs a minute and helps
 * a stranger.
 */
export const REDEMPTION = {
  /** Points per one minor unit (one rappen/cent) of real value. */
  rate: 200,
  /** Below this, converting is not worth the transaction. */
  minimumPoints: 5_000,
  /**
   * The cash-out leg, per household per rolling year, in minor units.
   *
   * Not a business rule — a regulatory one. Cash redemption across the whole scheme is what
   * counts toward the €1,000,000 / 12 months notification threshold, and a per-household cap
   * is the cheapest way to keep the aggregate somewhere a person can reason about. ADR-004
   * §7 owns the aggregate counter.
   */
  cashCapPerYear: 20_000,
} as const

/** Points, as a whole number. */
export type Points = Money

/**
 * The one gate through which points come into existence.
 *
 * Takes a *reason*, not an amount. A caller cannot ask for "500 points" — it can only say
 * what happened, and the table decides what that is worth. That is what makes the invariant
 * hold: there is no argument to this function that a payment could be smuggled through.
 */
export function assertEarnable(reason: string): asserts reason is EarnReason {
  if (!Object.prototype.hasOwnProperty.call(EARN_RULES, reason)) {
    throw new LedgerError(
      `"${reason}" is not a way to earn points. Points are earned by acts listed in ` +
        `EARN_RULES and can never be bought — see CONTRACTS.md §17.2.`,
    )
  }
}

/**
 * Mint points into a household's account.
 *
 * `alreadyToday` is what the caller has already awarded for this reason today, so the daily
 * cap is applied here rather than trusted to each call site. Returns `null` when the cap is
 * already reached, which is a normal outcome and not an error — the act still happened, it
 * simply earns nothing more.
 */
export function earn(input: {
  groupId: string
  reason: string
  alreadyToday: number
  /** Makes the mint idempotent: the same act delivered twice mints once. */
  eventKey: string
}): Transfer | null {
  assertEarnable(input.reason)
  const rule = EARN_RULES[input.reason]

  if (input.alreadyToday >= rule.perDay) return null

  return transfer({
    idempotencyKey: `earn:${input.eventKey}`,
    reason: rule.label,
    from: TREASURY,
    to: accountId('household', input.groupId),
    amount: rule.points,
    currency: POINTS,
  })
}

/** What a points balance is worth, in minor units of `currency`. Rounds down, always. */
export function worthInMinorUnits(points: Points): number {
  assertMoney(points, 'points')
  if (points < 0) throw new LedgerError('A negative points balance cannot be converted')
  // Down, not to nearest. Rounding a conversion in the customer's favour at every redemption
  // is a slow leak, and rounding against them at every redemption is worse.
  return Math.floor(points / REDEMPTION.rate)
}

/** How many points a given amount of real value costs. Rounds up, for the same reason. */
export function pointsFor(minorUnits: number): Points {
  assertMoney(minorUnits, 'amount')
  return Math.ceil(minorUnits * REDEMPTION.rate)
}

export interface RedemptionCheck {
  ok: boolean
  /** Written for a person, when it is not ok. */
  reason?: string
  /** What they would get, in minor units. */
  value?: number
}

/**
 * Whether a household may convert `points` right now.
 *
 * The caller supplies what has already been cashed out this year, because that number lives
 * in the ledger and this function stays pure.
 */
export function canRedeem(input: {
  points: Points
  balance: Points
  cashedOutThisYear: number
}): RedemptionCheck {
  assertMoney(input.points, 'points to redeem')

  if (input.points <= 0) return { ok: false, reason: 'Choose how many points to convert.' }
  if (input.points > input.balance) {
    return { ok: false, reason: 'That is more points than this household has.' }
  }
  if (input.points < REDEMPTION.minimumPoints) {
    return {
      ok: false,
      reason: `Converting starts at ${REDEMPTION.minimumPoints.toLocaleString('en-CH')} points.`,
    }
  }

  const value = worthInMinorUnits(input.points)
  if (input.cashedOutThisYear + value > REDEMPTION.cashCapPerYear) {
    return {
      ok: false,
      reason: 'This household has reached the amount it can convert to cash this year.',
    }
  }

  return { ok: true, value }
}

/**
 * Burn points and record the value owed.
 *
 * The points leg only. Paying the household is a separate movement in real currency, made by
 * whatever is actually holding money, and deliberately not modelled here: a function that
 * pretended to do both would be claiming this app can pay somebody, which it cannot until
 * ADR-004 §7 is resolved.
 */
export function redeem(input: { groupId: string; points: Points; eventKey: string }): Transfer {
  assertMoney(input.points, 'points to redeem')
  if (input.points <= 0) throw new LedgerError('A redemption converts a positive number')

  return transfer({
    idempotencyKey: `redeem:${input.eventKey}`,
    reason: 'Converted points',
    from: accountId('household', input.groupId),
    to: TREASURY,
    amount: input.points,
    currency: POINTS,
  })
}

/**
 * A rung on the ladder, purely for display.
 *
 * Named rather than numbered, because "level 7" means nothing and "you have rated enough
 * places to be worth listening to" means something. The thresholds widen, so the early ones
 * arrive quickly and the later ones are worth reaching.
 */
export const STANDINGS = [
  { at: 0, name: 'Just started' },
  { at: 250, name: 'Finding your feet' },
  { at: 1_000, name: 'Regulars' },
  { at: 3_000, name: 'Worth listening to' },
  { at: 8_000, name: 'Local knowledge' },
  { at: 20_000, name: 'Written the guide' },
] as const

export function standingFor(points: Points): { name: string; next: number | null; into: number } {
  type Rung = { readonly at: number; readonly name: string }
  let current: Rung = STANDINGS[0]
  for (const rung of STANDINGS as readonly Rung[]) if (points >= rung.at) current = rung

  const index = (STANDINGS as readonly Rung[]).indexOf(current)
  const next: Rung | null = (STANDINGS as readonly Rung[])[index + 1] ?? null
  const span = next === null ? 0 : next.at - current.at
  return {
    name: current.name,
    next: next?.at ?? null,
    into: span === 0 ? 1 : Math.min(1, (points - current.at) / span),
  }
}
