import { describe, expect, it } from 'vitest'

import {
  SettlementError,
  summariseEvent,
  summarisePeriod,
  type TotalsInput,
} from '../srv/lib/settlement'

/**
 * CONTRACTS.md §9.
 *
 * There is no debt in this app, so there is nothing here about who owes whom.
 * What is left is the arithmetic that is still easy to get wrong: the roster
 * (everybody appears, spender or not), the proportion (never `NaN`), the head
 * count (never a division by zero) and the single half-up rounding at the end.
 */

const ADA = 'a0000000-0000-4000-8000-000000000001'
const BRUNO = 'b0000000-0000-4000-8000-000000000002'
const NOEMI = 'c0000000-0000-4000-8000-000000000003'
const LUCA = 'd0000000-0000-4000-8000-000000000004'

const LISBON = { ID: 'e0000000-0000-4000-8000-000000000001', name: 'Lisbon Weekend' }
const DINNER = { ID: 'e0000000-0000-4000-8000-000000000002', name: 'Kronenhalle Dinner' }

/** Three people, because two would let a hard-coded pair hide in a passing test. */
const HOUSEHOLD = [
  { ID: ADA, name: 'Ada' },
  { ID: BRUNO, name: 'Bruno' },
  { ID: NOEMI, name: 'Noemi' },
]

const PERIOD = '2031-03'

/** A row builder, so each test states only the field it is actually about. */
function row(overrides: Partial<TotalsInput> = {}): TotalsInput {
  return { amount: 100, paidById: ADA, eventId: null, date: '2031-03-14', ...overrides }
}

describe('summarisePeriod', () => {
  it('lists the whole roster, including whoever paid for nothing', () => {
    const totals = summarisePeriod(
      [row({ amount: 60, paidById: ADA }), row({ amount: 40, paidById: BRUNO })],
      PERIOD,
      HOUSEHOLD,
    )

    expect(totals).toEqual({
      period: PERIOD,
      grandTotal: 100,
      count: 2,
      byPerson: [
        { personId: ADA, name: 'Ada', paid: 60, count: 1, share: 0.6 },
        { personId: BRUNO, name: 'Bruno', paid: 40, count: 1, share: 0.4 },
        // A quiet month is still a month on the roster, not an absence.
        { personId: NOEMI, name: 'Noemi', paid: 0, count: 0, share: 0 },
      ],
    })
  })

  it('orders by what was paid, then by name', () => {
    const totals = summarisePeriod(
      [
        row({ amount: 10, paidById: BRUNO }),
        row({ amount: 30, paidById: NOEMI }),
        row({ amount: 10, paidById: ADA }),
      ],
      PERIOD,
      HOUSEHOLD,
    )

    expect(totals.byPerson.map(person => person.name)).toEqual(['Noemi', 'Ada', 'Bruno'])
  })

  it('reports shares as proportions of the total that add up to one', () => {
    const totals = summarisePeriod(
      [
        row({ amount: 40, paidById: ADA }),
        row({ amount: 35, paidById: BRUNO }),
        row({ amount: 25, paidById: NOEMI }),
      ],
      PERIOD,
      HOUSEHOLD,
    )

    expect(totals.byPerson.map(person => person.share)).toEqual([0.4, 0.35, 0.25])
    expect(totals.byPerson.reduce((sum, person) => sum + person.share, 0)).toBeCloseTo(1, 10)
  })

  it('keeps three equal shares adding up to one', () => {
    const totals = summarisePeriod(
      [
        row({ amount: 10, paidById: ADA }),
        row({ amount: 10, paidById: BRUNO }),
        row({ amount: 10, paidById: NOEMI }),
      ],
      PERIOD,
      HOUSEHOLD,
    )

    for (const person of totals.byPerson) expect(person.share).toBeCloseTo(1 / 3, 12)
    expect(totals.byPerson.reduce((sum, person) => sum + person.share, 0)).toBeCloseTo(1, 10)
  })

  it('gives every share as 0 rather than NaN when nothing was spent', () => {
    const empty = summarisePeriod([], PERIOD, HOUSEHOLD)

    expect(empty.grandTotal).toBe(0)
    expect(empty.count).toBe(0)
    expect(empty.byPerson).toHaveLength(3)
    for (const person of empty.byPerson) {
      expect(person.paid).toBe(0)
      expect(person.share).toBe(0)
    }
  })

  it('divides a month of zero-franc postings without producing NaN', () => {
    // The month is not empty — somebody posted a comped dinner — but the total
    // is still 0, which is the division this has to survive.
    const totals = summarisePeriod([row({ amount: 0 }), row({ amount: 0 })], PERIOD, HOUSEHOLD)

    expect(totals.count).toBe(2)
    expect(totals.grandTotal).toBe(0)
    expect(totals.byPerson.map(person => person.share)).toEqual([0, 0, 0])
    expect(totals.byPerson[0]).toMatchObject({ name: 'Ada', paid: 0, count: 2 })
  })

  it('counts only the rows inside the period', () => {
    const totals = summarisePeriod(
      [
        row({ amount: 10, date: '2031-02-28' }),
        row({ amount: 20, date: '2031-03-01' }),
        row({ amount: 30, date: '2031-03-31' }),
        row({ amount: 40, date: '2031-04-01' }),
      ],
      PERIOD,
      HOUSEHOLD,
    )

    expect(totals).toMatchObject({ period: PERIOD, grandTotal: 50, count: 2 })
  })

  it('keeps a posting by someone off the roster in the total, without inventing a line', () => {
    // The money was genuinely spent; it just has no name on it any more.
    const totals = summarisePeriod(
      [row({ amount: 60, paidById: ADA }), row({ amount: 40, paidById: LUCA })],
      PERIOD,
      HOUSEHOLD,
    )

    expect(totals.grandTotal).toBe(100)
    expect(totals.count).toBe(2)
    expect(totals.byPerson.map(person => person.personId)).toEqual([ADA, BRUNO, NOEMI])
    expect(totals.byPerson[0]).toMatchObject({ paid: 60, share: 0.6 })
  })

  it('rounds half-up to two decimals once, at the end', () => {
    // Two CHF 1.005 postings are 2.01 exactly, then 2.01 rounded. Rounding each
    // row first would report 1.01 + 1.01 = CHF 2.02 and invent a rappen.
    const totals = summarisePeriod(
      [row({ amount: 1.005, paidById: ADA }), row({ amount: 1.005, paidById: ADA })],
      PERIOD,
      HOUSEHOLD,
    )

    expect(totals.grandTotal).toBe(2.01)
    expect(totals.byPerson[0]).toMatchObject({ name: 'Ada', paid: 2.01, count: 2 })
  })

  it('rounds a lone half-rappen away from zero, not down', () => {
    // 2.345 is a genuine .005 boundary: half-up gives 2.35, and the naive
    // `Math.round(2.345 * 100)` gives 2.34 because the product is 234.49999…
    const totals = summarisePeriod([row({ amount: 2.345 })], PERIOD, HOUSEHOLD)

    expect(totals.grandTotal).toBe(2.35)
    expect(totals.byPerson[0].paid).toBe(2.35)
  })

  it('merges a person listed twice into one line', () => {
    const totals = summarisePeriod([row({ amount: 20 })], PERIOD, [
      { ID: ADA, name: 'Ada' },
      { ID: ADA, name: 'Ada again' },
    ])

    expect(totals.byPerson).toEqual([{ personId: ADA, name: 'Ada', paid: 20, count: 1, share: 1 }])
  })

  it('trims the names it is given', () => {
    const totals = summarisePeriod([], PERIOD, [{ ID: ADA, name: '  Ada  ' }])

    expect(totals.byPerson[0].name).toBe('Ada')
  })

  it('refuses a period that is not a month', () => {
    expect(() => summarisePeriod([], '2031-13', HOUSEHOLD)).toThrow(SettlementError)
    expect(() => summarisePeriod([], 'March', HOUSEHOLD)).toThrow(/period must be YYYY-MM/)
  })

  it('refuses a row whose date is not a date', () => {
    expect(() => summarisePeriod([row({ date: '31.03.2031' })], PERIOD, HOUSEHOLD)).toThrow(
      /row 0: date must be YYYY-MM-DD/,
    )
  })

  it('refuses a row whose amount is not a number', () => {
    const broken = [row(), { ...row(), amount: Number.NaN }]

    expect(() => summarisePeriod(broken, PERIOD, HOUSEHOLD)).toThrow(/row 1: amount/)
  })

  it('refuses a roster entry without an id', () => {
    expect(() => summarisePeriod([], PERIOD, [{ ID: '  ', name: 'Nobody' }])).toThrow(
      /people\[0\]\.ID/,
    )
  })
})

describe('summariseEvent', () => {
  const GUESTS = [
    { ID: ADA, name: 'Ada' },
    { ID: BRUNO, name: 'Bruno' },
    { ID: NOEMI, name: 'Noemi' },
  ]

  it('totals only the rows of that event, over the people who were on it', () => {
    const totals = summariseEvent(
      [
        row({ amount: 300, paidById: ADA, eventId: LISBON.ID, date: '2031-04-10' }),
        row({ amount: 120, paidById: NOEMI, eventId: LISBON.ID, date: '2031-04-11' }),
        row({ amount: 90, paidById: BRUNO, eventId: DINNER.ID, date: '2031-06-15' }),
        row({ amount: 50, paidById: BRUNO, eventId: null, date: '2031-04-11' }),
      ],
      LISBON,
      GUESTS,
    )

    expect(totals).toEqual({
      eventId: LISBON.ID,
      name: 'Lisbon Weekend',
      grandTotal: 420,
      perHead: 140,
      participantCount: 3,
      count: 2,
      byPerson: [
        { personId: ADA, name: 'Ada', paid: 300, count: 1, share: 300 / 420 },
        { personId: NOEMI, name: 'Noemi', paid: 120, count: 1, share: 120 / 420 },
        // On the trip, paid for nothing — still on the trip.
        { personId: BRUNO, name: 'Bruno', paid: 0, count: 0, share: 0 },
      ],
    })
  })

  it('counts the whole event even when a guest list is a subset of the household', () => {
    const totals = summariseEvent(
      [
        row({ amount: 100, paidById: ADA, eventId: DINNER.ID }),
        row({ amount: 114, paidById: BRUNO, eventId: DINNER.ID }),
      ],
      DINNER,
      [{ ID: ADA, name: 'Ada' }],
    )

    // Bruno was not on the dinner, so he gets no line — but his CHF 114 was
    // spent on it, and the event total says so.
    expect(totals.grandTotal).toBe(214)
    expect(totals.count).toBe(2)
    expect(totals.participantCount).toBe(1)
    expect(totals.byPerson).toEqual([
      { personId: ADA, name: 'Ada', paid: 100, count: 1, share: 100 / 214 },
    ])
  })

  it('divides the total by the head count, rounding half-up', () => {
    // CHF 10.01 between two is 5.005 — a genuine half-rappen, rounded away from
    // zero exactly once, at the end.
    const totals = summariseEvent(
      [
        row({ amount: 5, paidById: ADA, eventId: DINNER.ID }),
        row({ amount: 5.01, paidById: BRUNO, eventId: DINNER.ID }),
      ],
      DINNER,
      [
        { ID: ADA, name: 'Ada' },
        { ID: BRUNO, name: 'Bruno' },
      ],
    )

    expect(totals.grandTotal).toBe(10.01)
    expect(totals.perHead).toBe(5.01)
  })

  it('reports 0 per head when nobody has been added to the event yet', () => {
    const totals = summariseEvent([row({ amount: 80, eventId: DINNER.ID })], DINNER, [])

    expect(totals.participantCount).toBe(0)
    expect(totals.perHead).toBe(0)
    expect(totals.byPerson).toEqual([])
    expect(totals.grandTotal).toBe(80)
  })

  it('is empty, not broken, for an event nothing was posted to', () => {
    const totals = summariseEvent([row({ eventId: LISBON.ID })], DINNER, GUESTS)

    expect(totals).toMatchObject({ grandTotal: 0, count: 0, perHead: 0, participantCount: 3 })
    expect(totals.byPerson.map(person => person.share)).toEqual([0, 0, 0])
  })

  it('ignores the date window entirely — an event is not a month', () => {
    const totals = summariseEvent(
      [
        row({ amount: 10, eventId: DINNER.ID, date: '2030-12-31' }),
        row({ amount: 10, eventId: DINNER.ID, date: '2032-01-01' }),
      ],
      DINNER,
      GUESTS,
    )

    expect(totals.grandTotal).toBe(20)
    expect(totals.count).toBe(2)
  })

  it('refuses an event without an id', () => {
    expect(() => summariseEvent([], { ID: '', name: 'Nameless' }, GUESTS)).toThrow(/event\.ID/)
  })
})
