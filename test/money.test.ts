/**
 * The ledger and the points on top of it.
 *
 * Two properties in this file are worth more than the rest put together, and both would be
 * silent failures rather than visible ones:
 *
 *  - **Every movement balances.** A ledger that can be written unbalanced is a ledger where
 *    a total is a suggestion. It is checked here per operation and again across a whole
 *    simulated history.
 *  - **Points cannot be bought.** That single fact is what keeps this feature out of e-money
 *    regulation, so it is asserted as a property of the code rather than trusted to the
 *    comment that explains it.
 */
import { describe, expect, it } from 'vitest'

import {
  LedgerError,
  accountId,
  allocate,
  assertMoney,
  balanceOf,
  formatMoney,
  postings,
  proves,
  transfer,
  type Posting,
} from '../srv/lib/money/ledger'
import {
  EARN_RULES,
  POINTS,
  REDEMPTION,
  TREASURY,
  assertEarnable,
  canRedeem,
  earn,
  pointsFor,
  redeem,
  standingFor,
  worthInMinorUnits,
} from '../srv/lib/money/points'

const CHF = 'CHF'

describe('minor units', () => {
  it('refuses a decimal, and says what the caller probably meant', () => {
    // The error people actually make: passing francs where rappen were wanted. Truncating
    // silently would lose a third of a franc a row until somebody noticed the totals.
    expect(() => assertMoney(12.34)).toThrow(/1234/)
  })

  it('refuses anything that is not a finite number', () => {
    for (const bad of [NaN, Infinity, '100', null, undefined, {}]) {
      expect(() => assertMoney(bad)).toThrow(LedgerError)
    }
  })

  it('refuses an integer too large to be exact', () => {
    expect(() => assertMoney(Number.MAX_SAFE_INTEGER + 2)).toThrow(/exact/)
  })
})

describe('a movement has two sides', () => {
  it('refuses postings that do not sum to zero', () => {
    expect(() =>
      postings([
        { account: 'a', amount: -100, currency: CHF },
        { account: 'b', amount: 90, currency: CHF },
      ]),
    ).toThrow(/sum to -10/)
  })

  it('refuses a one-sided movement', () => {
    expect(() => postings([{ account: 'a', amount: 100, currency: CHF }])).toThrow(/somewhere/)
  })

  it('requires each currency to balance on its own', () => {
    // The subtle one. These four postings sum to zero if you add the numbers and ignore the
    // currencies, which is exactly the bug an unchecked ledger hides for months.
    expect(() =>
      postings([
        { account: 'a', amount: -100, currency: 'CHF' },
        { account: 'b', amount: 100, currency: 'CHF' },
        { account: 'c', amount: -50, currency: 'EUR' },
        { account: 'd', amount: 50, currency: 'EUR' },
      ]),
    ).not.toThrow()

    expect(() =>
      postings([
        { account: 'a', amount: -100, currency: 'CHF' },
        { account: 'b', amount: 100, currency: 'EUR' },
      ]),
    ).toThrow(/CHF/)
  })

  it('takes a fee out of the amount sent, not out of thin air', () => {
    const moved = transfer({
      idempotencyKey: 'k1',
      reason: 'top-up',
      from: 'external:card',
      to: 'household:g1',
      amount: 5_000,
      currency: CHF,
      fee: { account: 'fees:stripe', amount: 175 },
    })

    expect(proves(moved.postings)).toBe(true)
    expect(balanceOf(moved.postings, 'household:g1', CHF)).toBe(4_825)
    expect(balanceOf(moved.postings, 'fees:stripe', CHF)).toBe(175)
    expect(balanceOf(moved.postings, 'external:card', CHF)).toBe(-5_000)
  })

  it('refuses a fee that swallows the transfer', () => {
    expect(() =>
      transfer({
        idempotencyKey: 'k',
        reason: 'x',
        from: 'a',
        to: 'b',
        amount: 100,
        currency: CHF,
        fee: { account: 'fees', amount: 100 },
      }),
    ).toThrow(/exceed/)
  })
})

describe('splitting without losing a cent', () => {
  it('gives back exactly what it was given', () => {
    // 10.00 three ways is not 3.33 three times: that is 9.99, and the missing cent is the
    // oldest bug in payments.
    const shares = allocate(1_000, 3)
    expect(shares).toEqual([334, 333, 333])
    expect(shares.reduce((sum, one) => sum + one, 0)).toBe(1_000)
  })

  it('holds for every amount and every number of ways', () => {
    for (let amount = 0; amount <= 200; amount += 7) {
      for (let parts = 1; parts <= 9; parts += 1) {
        const shares = allocate(amount, parts)
        expect(shares.reduce((sum, one) => sum + one, 0)).toBe(amount)
        // No share may be more than one minor unit away from any other.
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('gives the spare units to the largest remainders when weighted', () => {
    const shares = allocate(1_000, [1, 1, 8])
    expect(shares.reduce((sum, one) => sum + one, 0)).toBe(1_000)
    expect(shares[2]).toBe(800)
  })

  it('splits a negative amount without losing anything either', () => {
    const shares = allocate(-1_000, 3)
    expect(shares.reduce((sum, one) => sum + one, 0)).toBe(-1_000)
  })
})

describe('formatting for a person', () => {
  it('renders minor units in the currency of the place', () => {
    expect(formatMoney(1_250, 'CHF')).toMatch(/12\.50/)
  })

  it('knows that yen has no minor unit', () => {
    // Assuming two decimal places everywhere is what makes yen amounts a hundred times too
    // small, and it survives review because it looks right in every European test.
    // The separator is the locale's business (en-CH uses an apostrophe); what matters is
    // that 1250 minor units is twelve hundred and fifty yen, not twelve francs fifty.
    const yen = formatMoney(1_250, 'JPY')
    expect(yen).toMatch(/1.250/)
    expect(yen).not.toMatch(/12[.,]50/)
  })
})

/* ------------------------------------------------------------------ points */

describe('points cannot be bought', () => {
  it('has no earn rule that takes an amount of money', () => {
    // The invariant, checked structurally. Every rule is a fixed number of points for an
    // act. A rule carrying a rate, a price or a multiplier would be points issued on
    // receipt of funds, which is e-money, which needs a licence.
    for (const [name, rule] of Object.entries(EARN_RULES)) {
      expect(Object.keys(rule).sort(), name).toEqual(['label', 'perDay', 'points'])
      expect(typeof rule.points, name).toBe('number')
      expect(Number.isInteger(rule.points), name).toBe(true)
    }
  })

  it('refuses to mint for a reason that is not an act on the list', () => {
    for (const attempt of ['purchased', 'topUp', 'bonus', 'subscription', 'admin']) {
      expect(() => assertEarnable(attempt)).toThrow(/never be bought/)
    }
  })

  it('has no rule that scales with money spent', () => {
    // The dark pattern this app refuses: rewarding a household in proportion to what it
    // spends is training two people to spend more together and calling it a gift.
    const names = Object.keys(EARN_RULES).join(' ').toLowerCase()
    for (const forbidden of ['amount', 'spend', 'percent', 'cashback', 'perfranc', 'total']) {
      expect(names, forbidden).not.toContain(forbidden)
    }
  })
})

describe('earning', () => {
  it('mints out of the treasury, so the total in existence is always knowable', () => {
    const minted = earn({ groupId: 'g1', reason: 'placeRated', alreadyToday: 0, eventKey: 'r1' })
    expect(minted).not.toBeNull()
    if (minted === null) return

    expect(proves(minted.postings)).toBe(true)
    expect(balanceOf(minted.postings, accountId('household', 'g1'), POINTS)).toBe(
      EARN_RULES.placeRated.points,
    )
    expect(balanceOf(minted.postings, TREASURY, POINTS)).toBe(-EARN_RULES.placeRated.points)
  })

  it('stops at the daily cap rather than failing', () => {
    // A normal outcome. The act still happened; it simply earns nothing more, and a caller
    // should not have to handle an exception for the ordinary case of an enthusiastic day.
    const capped = earn({
      groupId: 'g1',
      reason: 'placeRated',
      alreadyToday: EARN_RULES.placeRated.perDay,
      eventKey: 'r2',
    })
    expect(capped).toBeNull()
  })

  it('mints once for one act however many times it is delivered', () => {
    const first = earn({ groupId: 'g', reason: 'memoryWritten', alreadyToday: 0, eventKey: 'm7' })
    const again = earn({ groupId: 'g', reason: 'memoryWritten', alreadyToday: 0, eventKey: 'm7' })
    // Same key, so the writer rejects the second. The ledger enforces it; the shape is what
    // this asserts.
    expect(first?.idempotencyKey).toBe(again?.idempotencyKey)
  })

  it('pays most for the act that helps other households', () => {
    // The cold-start problem is the real one: a commons nobody contributes to is worth
    // nothing to anybody. So rating a place outranks every private act.
    const private_ = [
      EARN_RULES.expenseConfirmed.points,
      EARN_RULES.receiptScanned.points,
      EARN_RULES.moodsBoth.points,
    ]
    expect(EARN_RULES.placeRated.points).toBeGreaterThan(Math.max(...private_))
  })
})

describe('converting points', () => {
  it('rounds a conversion down, never to nearest', () => {
    // Rounding in the customer's favour at every redemption is a slow leak; rounding against
    // them at every redemption is worse. Down and stated is the honest choice.
    expect(worthInMinorUnits(REDEMPTION.rate * 10 + REDEMPTION.rate - 1)).toBe(10)
  })

  it('rounds a price up, for the same reason in the other direction', () => {
    expect(pointsFor(1)).toBe(REDEMPTION.rate)
  })

  it('refuses below the minimum, and says what the minimum is', () => {
    const check = canRedeem({ points: 100, balance: 10_000, cashedOutThisYear: 0 })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/5,000|5.000/)
  })

  it('refuses more points than the household has', () => {
    expect(canRedeem({ points: 10_000, balance: 6_000, cashedOutThisYear: 0 }).ok).toBe(false)
  })

  it('refuses past the yearly cash cap', () => {
    // A regulatory limit rather than a business one: the cash leg is what accumulates
    // toward the €1m/12-month notification threshold.
    const check = canRedeem({
      points: pointsFor(REDEMPTION.cashCapPerYear),
      balance: Number.MAX_SAFE_INTEGER - 1,
      cashedOutThisYear: 1,
    })
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/this year/)
  })

  it('burns back to the treasury, so points redeemed stop existing', () => {
    const burnt = redeem({ groupId: 'g1', points: 10_000, eventKey: 'x' })
    expect(proves(burnt.postings)).toBe(true)
    expect(balanceOf(burnt.postings, accountId('household', 'g1'), POINTS)).toBe(-10_000)
  })
})

describe('standing', () => {
  it('starts everybody somewhere and names it rather than numbering it', () => {
    // "Level 7" means nothing. "Worth listening to" means something.
    expect(standingFor(0).name).toBe('Just started')
    expect(standingFor(5_000).name).toBe('Worth listening to')
    expect(standingFor(999_999).next).toBeNull()
  })

  it('reports progress into the next rung as a fraction', () => {
    const at = standingFor(625)
    expect(at.into).toBeGreaterThan(0)
    expect(at.into).toBeLessThan(1)
  })
})

describe('a whole history still balances', () => {
  it('sums to zero across every account and currency', () => {
    // The property that makes the ledger auditable: at any instant, adding up everything
    // gives exactly zero. Anything else is a bug rather than a mystery.
    const history: Posting[] = []

    for (let day = 0; day < 40; day += 1) {
      const minted = earn({
        groupId: `g${day % 5}`,
        reason: day % 3 === 0 ? 'placeRated' : 'receiptScanned',
        alreadyToday: 0,
        eventKey: `e${day}`,
      })
      if (minted !== null) history.push(...minted.postings)

      history.push(
        ...transfer({
          idempotencyKey: `t${day}`,
          reason: 'a dinner',
          from: 'external:card',
          to: `household:g${day % 5}`,
          amount: 1_000 + day,
          currency: CHF,
          fee: { account: 'fees:stripe', amount: 29 },
        }).postings,
      )
    }

    history.push(...redeem({ groupId: 'g1', points: 200, eventKey: 'r' }).postings)

    expect(proves(history)).toBe(true)
    expect(history.length).toBeGreaterThan(200)
  })
})
