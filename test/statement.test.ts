import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { LlmProvider, LlmRequest } from '../srv/lib/llm'
import { createTemplateProvider } from '../srv/lib/llm/template'
import {
  STATEMENT_MAX_TOKENS,
  STATEMENT_SYSTEM_PROMPT,
  aggregateYear,
  generateStatement,
  renderTemplateStatement,
  type StatementDb,
  type StatementFacts,
} from '../srv/lib/statement'

/**
 * CONTRACTS.md §8, against a real CAP database.
 *
 * The year is synthetic and seeded here rather than read from `db/data/*.csv`:
 * the seed is a living demo fixture that other work is free to change, and a
 * statement test that breaks when someone adds a receipt is a test nobody
 * trusts. The database itself is real, though — `db/schema.cds` deployed to an
 * in-memory SQLite — because the part of `aggregateYear()` most likely to be
 * wrong is the query, and a hand-written fake database would have agreed with
 * whatever the query happened to say.
 *
 * Three people, not two: the household has no fixed size (§10), and a fixture
 * with exactly two people lets a hard-coded pair pass unnoticed.
 */

const YEAR = 2031
const ADA = 'a0000000-0000-4000-8000-000000000001'
const BRUNO = 'b0000000-0000-4000-8000-000000000002'
const NOEMI = 'c0000000-0000-4000-8000-000000000003'

const LISBON = 'f0000000-0000-4000-8000-000000000001'
const SILS = 'f0000000-0000-4000-8000-000000000002'
const CANCELLED = 'f0000000-0000-4000-8000-000000000003'

const REQUIRED_SECTIONS = [
  '## Executive Summary',
  '## Key Achievements',
  '## Investment Overview',
  '## Highlights by Quarter',
  '## Outlook',
  '## Closing note',
]

let db: StatementDb
let facts: StatementFacts

beforeAll(async () => {
  db = await deployTestDb()
  await reseed(syntheticYear())
  facts = await aggregateYear(YEAR, db)
}, 60_000)

describe('aggregateYear', () => {
  it('names everyone who could have paid, and the reporting period', () => {
    expect(facts.year).toBe(YEAR)
    expect(facts.people).toEqual(['Ada', 'Bruno', 'Noemi'])
    expect(facts.currency).toBe('CHF')
  })

  it('counts only confirmed expenses inside the year', () => {
    // The fixture also holds a 2031 draft, a 2030 posting and a 2032 posting,
    // each far too large to hide in a total if it leaked in.
    expect(facts.counts.expenses).toBe(15)
    expect(facts.totals.overall).toBe(1150)
  })

  it('totals by category in contract order, omitting the codes with no spend', () => {
    expect(Object.keys(facts.totals.byCategory)).toEqual([
      'Groceries',
      'Dining',
      'Cafes',
      'Transport',
      'Travel',
      'Gifts',
      'Entertainment',
    ])
    expect(facts.totals.byCategory).toEqual({
      Groceries: 120,
      Dining: 305,
      Cafes: 30,
      Transport: 45,
      Travel: 400,
      Gifts: 210,
      Entertainment: 40,
    })
  })

  it('totals by moment in contract order', () => {
    expect(Object.keys(facts.totals.byMoment)).toEqual(['everyday', 'date_night', 'trip', 'gift'])
    expect(facts.totals.byMoment).toEqual({
      everyday: 120,
      date_night: 300,
      trip: 520,
      gift: 210,
    })
  })

  it('totals what each person paid, over the whole roster', () => {
    // Keyed by name, because that is the string the renderer prints. Noemi paid
    // for nothing all year and is still in the report: what a person paid is a
    // contribution, and 0 is a perfectly good contribution — it is never a debt.
    expect(facts.totals.byPerson).toEqual({ Ada: 515, Bruno: 635, Noemi: 0 })
    expect(Object.keys(facts.totals.byPerson)).toEqual(facts.people)
    const paid = Object.values(facts.totals.byPerson).reduce((sum, value) => sum + value, 0)
    expect(paid).toBe(facts.totals.overall)
  })

  it('carries no notion of debt in the facts at all', () => {
    expect(Object.keys(facts.totals)).toEqual(['overall', 'byCategory', 'byPerson', 'byMoment'])
    expect(JSON.stringify(facts)).not.toMatch(/owe|owed|balance|byPartner|shareA|split/i)
  })

  it('counts evenings, trips and gifts', () => {
    expect(facts.counts).toEqual({
      expenses: 15,
      // Six date_night rows, but the dinner and the taxi home of 14 March are
      // one evening — as with trips, this counts occasions, not postings.
      dateNights: 5,
      trips: 3,
      // Two gifts happened. Who gave which to whom is nobody's ledger.
      gifts: 2,
    })
  })

  it('reports what each event cost and how many people were on it', () => {
    // Largest first, and the weekend nobody spent anything on is not a line in
    // an annual report.
    expect(facts.events).toEqual([
      { name: 'Sils in July', total: 345, participantCount: 2 },
      { name: 'Lisbon in February', total: 175, participantCount: 3 },
    ])
  })

  it('ranks merchants by spend, folding spellings together under the normalised name', () => {
    expect(facts.topMerchants).toEqual([
      { merchant: 'Waldhaus Sils', total: 300, visits: 1 },
      { merchant: 'Kronenhalle', total: 210, visits: 3 },
      // Same merchantNorm, two spellings, so the two Migros trips are one
      // counterparty — and it outranks an equal total with fewer visits.
      { merchant: 'MIGROS ZÜRICH HB', total: 120, visits: 2 },
      { merchant: 'Buchhandlung Orell', total: 120, visits: 1 },
      { merchant: 'Hotel Estrela', total: 100, visits: 1 },
    ])
  })

  it('lists the places, most visited first', () => {
    expect(facts.placesVisited).toEqual(['Zürich', 'Lisbon', 'Sils', 'Porto'])
  })

  it('bookends the year with its first and last written-up memory', () => {
    expect(facts.firstMemory).toEqual({
      title: 'Lisbon, the long way round',
      date: '2031-02-11',
    })
    expect(facts.lastMemory).toEqual({ title: 'Sils, and the lake', date: '2031-07-15' })
  })

  it('splits the year into four quarters and highlights each one', () => {
    expect(facts.quarters).toEqual([
      // A memory always beats a posting...
      { quarter: 1, total: 375, highlight: 'Lisbon, the long way round' },
      // ...and a quarter nobody wrote up falls back to its largest posting.
      { quarter: 2, total: 220, highlight: "the quarter's largest posting was Buchhandlung Orell" },
      // Q3 has two memories: the pinned one wins over the earlier one.
      { quarter: 3, total: 490, highlight: 'Sils, and the lake' },
      { quarter: 4, total: 65, highlight: "the quarter's largest posting was Migros Zürich HB" },
    ])
    expect(facts.quarters.reduce((sum, q) => sum + q.total, 0)).toBe(facts.totals.overall)
  })

  it('reports the currency most of the year was spent in', async () => {
    await reseed({
      people: peopleRows(),
      expenses: [
        expense({ date: '2031-04-01', amount: 10, currency: 'EUR' }),
        expense({ date: '2031-04-02', amount: 10, currency: 'EUR' }),
        expense({ date: '2031-04-03', amount: 10, currency: 'CHF' }),
      ],
    })

    expect((await aggregateYear(YEAR, db)).currency).toBe('EUR')
  })

  it('leaves an expense whose payer no longer exists out of byPerson', async () => {
    // ...rather than filing it under a raw UUID, which reads as a stranger who
    // lives here. The money still happened, though — it only has no name on it.
    await reseed({
      people: peopleRows(),
      expenses: [
        expense({ date: '2031-04-01', amount: 10, paidBy: ADA }),
        expense({ date: '2031-04-02', amount: 25, paidBy: 'd0000000-0000-4000-8000-00000000000d' }),
      ],
    })

    const orphaned = await aggregateYear(YEAR, db)

    expect(orphaned.totals.byPerson).toEqual({ Ada: 10, Bruno: 0, Noemi: 0 })
    expect(orphaned.totals.overall).toBe(35)
  })

  it('leaves a person nobody has named out of the roster, keeping their spend in the total', async () => {
    // There is no placeholder for the fourth person, so an unnamed one is
    // reported as spending rather than as a name the statement has to address.
    await reseed({
      people: [
        { ID: ADA, name: '', colour: '#0070F2' },
        { ID: BRUNO, name: 'Bruno', colour: '#F31DED' },
      ],
      expenses: [
        expense({ date: '2031-04-01', amount: 10, paidBy: ADA }),
        expense({ date: '2031-04-02', amount: 25, paidBy: BRUNO }),
      ],
    })

    const nameless = await aggregateYear(YEAR, db)

    expect(nameless.people).toEqual(['Bruno'])
    expect(nameless.totals.byPerson).toEqual({ Bruno: 25 })
    expect(nameless.totals.overall).toBe(35)
  })

  it('keeps an expense whose event has been deleted, and drops the label', async () => {
    // Deleting an event detaches its expenses (§10); a stale event id must not
    // cost the year a posting.
    await reseed({
      people: peopleRows(),
      expenses: [
        expense({ date: '2031-04-01', amount: 40, event: LISBON }),
        expense({ date: '2031-04-02', amount: 60 }),
      ],
    })

    const detached = await aggregateYear(YEAR, db)

    expect(detached.events).toEqual([])
    expect(detached.totals.overall).toBe(100)
  })

  it('refuses a year that is not a year', async () => {
    await expect(aggregateYear(20.31, db)).rejects.toThrow(/four-digit calendar year/)
  })

  it('refuses a handle that is not a database', async () => {
    await expect(aggregateYear(YEAR, { query: 'select 1' })).rejects.toThrow(/no run\(\) method/)
  })
})

describe('trip clustering', () => {
  /** Seeds nothing but trip expenses on the given dates and counts the clusters. */
  async function tripsOn(...dates: string[]): Promise<number> {
    await reseed({
      people: peopleRows(),
      expenses: dates.map(date => expense({ date, amount: 10, moment: 'trip' })),
    })
    return (await aggregateYear(YEAR, db)).counts.trips
  }

  it('joins two expenses two days apart into one trip', async () => {
    await expect(tripsOn('2031-02-10', '2031-02-12')).resolves.toBe(1)
  })

  it('keeps two expenses four days apart as two trips', async () => {
    await expect(tripsOn('2031-02-10', '2031-02-14')).resolves.toBe(2)
  })

  it('treats exactly three days as still the same trip', async () => {
    await expect(tripsOn('2031-02-10', '2031-02-13')).resolves.toBe(1)
  })

  it('chains: a fortnight of three-day hops is one long trip', async () => {
    await expect(tripsOn('2031-06-01', '2031-06-04', '2031-06-07')).resolves.toBe(1)
  })

  it('sorts before clustering, so the row order cannot change the answer', async () => {
    await expect(tripsOn('2031-02-16', '2031-02-10', '2031-02-12')).resolves.toBe(2)
  })

  it('counts a lone trip expense as one trip, and no expenses as none', async () => {
    await expect(tripsOn('2031-02-10')).resolves.toBe(1)
    await expect(tripsOn()).resolves.toBe(0)
  })
})

describe('date-night streak', () => {
  async function streakOn(...dates: string[]): Promise<number> {
    await reseed({
      people: peopleRows(),
      expenses: dates.map(date => expense({ date, amount: 10, moment: 'date_night' })),
    })
    return (await aggregateYear(YEAR, db)).longestDateNightStreakWeeks
  }

  it('counts the longest run of consecutive ISO weeks, not the total', async () => {
    // W10, W11, W12 — then a week off — then W14, W15.
    await expect(
      streakOn('2031-03-07', '2031-03-14', '2031-03-21', '2031-04-04', '2031-04-11'),
    ).resolves.toBe(3)
  })

  it('counts two date nights in the same week once', async () => {
    // Friday and Sunday of ISO week 2031-W10.
    await expect(streakOn('2031-03-07', '2031-03-09')).resolves.toBe(1)
  })

  it('carries a streak across the ISO year boundary', async () => {
    // 22 Dec is 2031-W52; 29 and 31 Dec are both 2032-W01. Comparing week
    // numbers would read 52 → 1 as a break; comparing Mondays does not.
    await expect(streakOn('2031-12-22', '2031-12-29', '2031-12-31')).resolves.toBe(2)
  })

  it('is zero for a year with no date nights', async () => {
    await expect(streakOn()).resolves.toBe(0)
  })
})

describe('STATEMENT_SYSTEM_PROMPT', () => {
  it('forbids the model from inventing a debt out of the per-person totals', () => {
    // A model handed a table of per-person totals will volunteer who owes whom
    // unless it is told not to. There is nothing to settle: §9.
    expect(STATEMENT_SYSTEM_PROMPT).toContain('Nobody owes anybody')
    expect(STATEMENT_SYSTEM_PROMPT).toMatch(/records what each person PAID/)
    expect(STATEMENT_SYSTEM_PROMPT).toMatch(/no balances/i)
  })

  it('pins Swiss number formatting so a generated statement matches the template', () => {
    expect(STATEMENT_SYSTEM_PROMPT).toContain("CHF 18'420.55")
    expect(STATEMENT_SYSTEM_PROMPT).toContain('CHF 18,420.55')
  })

  it('never assumes there are two people', () => {
    expect(STATEMENT_SYSTEM_PROMPT).toMatch(/never assume\s+a couple/)
    expect(STATEMENT_SYSTEM_PROMPT).not.toMatch(/\bpartners?\b/i)
  })
})

describe('renderTemplateStatement', () => {
  /**
   * The prose belongs to `srv/lib/llm/template.ts`; what is pinned here is the
   * hand-off — the six sections CONTRACTS.md §7 requires, and the aggregated
   * figures actually reaching the renderer.
   */
  it('produces markdown with all six required sections', async () => {
    await reseed(syntheticYear())
    const markdown = renderTemplateStatement(await aggregateYear(YEAR, db))

    expect(markdown.startsWith('# Statement of Us — FY2031')).toBe(true)
    for (const heading of REQUIRED_SECTIONS) expect(markdown).toContain(heading)
  })

  it('puts the aggregated figures in the prose, in Swiss francs', () => {
    const markdown = renderTemplateStatement(facts)

    expect(markdown).toContain("CHF 1'150.00")
    expect(markdown).toContain('Lisbon, the long way round')
    expect(markdown).not.toMatch(/\bowes?\b|\bowed\b|settle up/i)
  })

  it('still writes all six sections for a year with nothing in it', async () => {
    await reseed({ people: peopleRows() })
    const empty = await aggregateYear(YEAR, db)

    expect(empty.totals.overall).toBe(0)
    expect(empty.counts.expenses).toBe(0)
    expect(empty.events).toEqual([])
    expect(empty.quarters.map(q => q.highlight)).toEqual([null, null, null, null])

    const markdown = renderTemplateStatement(empty)
    for (const heading of REQUIRED_SECTIONS) expect(markdown).toContain(heading)
  })
})

describe('generateStatement', () => {
  it('asks for a token budget the statement actually fits in', async () => {
    const seen: LlmRequest[] = []
    const spy: LlmProvider = {
      name: 'spy',
      async generate(req: LlmRequest): Promise<string> {
        seen.push(req)
        return '# Statement of Us\n'
      },
    }

    const result = await generateStatement(facts, spy)

    // CONTRACTS.md §7 defaults to 8000, which adaptive thinking can consume
    // before a word of the statement is written.
    expect(STATEMENT_MAX_TOKENS).toBe(32_000)
    expect(seen).toHaveLength(1)
    expect(seen[0].maxTokens).toBe(STATEMENT_MAX_TOKENS)
    expect(seen[0].prompt).toContain('"longestDateNightStreakWeeks": 3')
    expect(seen[0].prompt).toContain('"Sils in July"')
    expect(seen[0].system).toBe(STATEMENT_SYSTEM_PROMPT)
    expect(result.engine).toBe('spy')
  })

  it('hands the template provider a prompt it can rebuild the facts from', async () => {
    const result = await generateStatement(facts, createTemplateProvider())

    expect(result.engine).toBe('template')
    expect(result.markdown).toBe(renderTemplateStatement(facts).trim())
  })

  it('falls back to the deterministic renderer when the model fails', async () => {
    const broken: LlmProvider = {
      name: 'broken',
      generate: async (): Promise<string> => {
        throw new Error('502 Bad Gateway')
      },
    }

    const result = await generateStatement(facts, broken)

    expect(result.engine).toBe('template')
    for (const heading of REQUIRED_SECTIONS) expect(result.markdown).toContain(heading)
  })

  it('falls back when the model answers with nothing at all', async () => {
    const mute: LlmProvider = { name: 'mute', generate: async (): Promise<string> => '   ' }

    expect((await generateStatement(facts, mute)).engine).toBe('template')
  })

  it('says out loud that it fell back, without repeating the year at anyone', async () => {
    // A silent fallback means a mistyped API key produces a perfectly good
    // statement every year and nobody ever learns the model was never asked.
    // The warning must not carry the prompt: the facts are a whole year of the
    // household's spending, and a log line is the one place it must not end up.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const broken: LlmProvider = {
        name: 'broken',
        generate: async (): Promise<string> => {
          throw new Error('401 Unauthorized')
        },
      }

      await generateStatement(facts, broken)

      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('[statement]')
      expect(line).toContain('broken')
      expect(line).toContain('401 Unauthorized')
      expect(line).not.toContain('Kronenhalle')
      expect(line).not.toContain('longestDateNightStreakWeeks')
    } finally {
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

interface Seed {
  people?: Row[]
  events?: Row[]
  participants?: Row[]
  expenses?: Row[]
  memories?: Row[]
}

interface ExpenseSeed {
  date: string
  amount: number
  category?: string
  moment?: string
  merchantRaw?: string
  /** Defaults to the lowercased raw name; set explicitly to fold two spellings. */
  merchantNorm?: string
  paidBy?: string
  /** `Events.ID`, or absent for everyday spending. */
  event?: string
  place?: string
  currency?: string
  status?: 'draft' | 'confirmed'
}

interface MemorySeed {
  occurredOn: string
  title: string
  place?: string
  pinned?: boolean
}

/**
 * The year under test.
 *
 * Every figure a test asserts is derivable from this list by hand, which is the
 * point: 15 confirmed postings totalling CHF 1150, three decoys that must not
 * be counted, three memories, and three events — one of which nobody spent
 * anything on.
 */
function syntheticYear(): Seed {
  return {
    people: peopleRows(),
    events: [
      event({ ID: LISBON, name: 'Lisbon in February', startsOn: '2031-02-10' }),
      event({ ID: SILS, name: 'Sils in July', startsOn: '2031-07-01', endsOn: '2031-07-04' }),
      event({ ID: CANCELLED, name: 'The weekend we did not take', startsOn: '2031-10-02' }),
    ],
    participants: [
      // Noemi came to Lisbon and nothing else, and paid for none of it.
      { event_ID: LISBON, person_ID: ADA },
      { event_ID: LISBON, person_ID: BRUNO },
      { event_ID: LISBON, person_ID: NOEMI },
      { event_ID: SILS, person_ID: ADA },
      { event_ID: SILS, person_ID: BRUNO },
      { event_ID: CANCELLED, person_ID: ADA },
      { event_ID: CANCELLED, person_ID: BRUNO },
    ],
    expenses: [
      // Q1 — 375.00. A trip of two, then an isolated one, then four date nights.
      expense({
        date: '2031-02-10',
        amount: 100,
        category: 'Travel',
        moment: 'trip',
        merchantRaw: 'Hotel Estrela',
        place: 'Lisbon',
        event: LISBON,
      }),
      expense({
        date: '2031-02-12',
        amount: 50,
        category: 'Dining',
        moment: 'trip',
        merchantRaw: 'Restaurante Ponto',
        place: 'Lisbon',
        event: LISBON,
      }),
      expense({
        date: '2031-02-16',
        amount: 25,
        category: 'Transport',
        moment: 'trip',
        merchantRaw: 'CP Comboios',
        place: 'Porto',
        paidBy: BRUNO,
        event: LISBON,
      }),
      expense({
        date: '2031-03-07',
        amount: 80,
        category: 'Dining',
        moment: 'date_night',
        merchantRaw: 'Kronenhalle',
      }),
      expense({
        date: '2031-03-14',
        amount: 60,
        category: 'Dining',
        moment: 'date_night',
        merchantRaw: 'Kronenhalle',
        paidBy: BRUNO,
      }),
      // Same evening as the row above — the taxi home, not a second date night.
      expense({
        date: '2031-03-14',
        amount: 20,
        category: 'Transport',
        moment: 'date_night',
        merchantRaw: 'Taxi 44',
        paidBy: BRUNO,
      }),
      expense({
        date: '2031-03-21',
        amount: 40,
        category: 'Entertainment',
        moment: 'date_night',
        merchantRaw: 'Kino Riffraff',
      }),

      // Q2 — 220.00.
      expense({
        date: '2031-04-04',
        amount: 70,
        category: 'Dining',
        moment: 'date_night',
        merchantRaw: 'Kronenhalle',
      }),
      expense({
        date: '2031-04-11',
        amount: 30,
        category: 'Cafes',
        moment: 'date_night',
        merchantRaw: 'Café Sprüngli',
        paidBy: BRUNO,
      }),
      expense({
        date: '2031-05-02',
        amount: 120,
        category: 'Gifts',
        moment: 'gift',
        merchantRaw: 'Buchhandlung Orell',
      }),

      // Q3 — 490.00. A trip exactly three days apart, so it stays one trip.
      expense({
        date: '2031-07-01',
        amount: 300,
        category: 'Travel',
        moment: 'trip',
        merchantRaw: 'Waldhaus Sils',
        place: 'Sils',
        paidBy: BRUNO,
        event: SILS,
      }),
      expense({
        date: '2031-07-04',
        amount: 45,
        category: 'Dining',
        moment: 'trip',
        merchantRaw: 'Alpenrose',
        place: 'Sils',
        paidBy: BRUNO,
        event: SILS,
      }),
      expense({
        date: '2031-08-20',
        amount: 90,
        category: 'Gifts',
        moment: 'gift',
        merchantRaw: 'Blumen Krämer',
        paidBy: BRUNO,
      }),
      expense({
        date: '2031-09-09',
        amount: 55,
        category: 'Groceries',
        moment: 'everyday',
        merchantRaw: 'MIGROS ZÜRICH HB',
        merchantNorm: 'migros zuerich hb',
      }),

      // Q4 — 65.00. Same merchant as above, spelled differently.
      expense({
        date: '2031-11-11',
        amount: 65,
        category: 'Groceries',
        moment: 'everyday',
        merchantRaw: 'Migros Zürich HB',
        merchantNorm: 'migros zuerich hb',
        paidBy: BRUNO,
      }),

      // Decoys: none of these may reach a total.
      expense({ date: '2031-06-06', amount: 999, merchantRaw: 'Draft', status: 'draft' }),
      expense({ date: '2030-12-31', amount: 888, merchantRaw: 'Last year' }),
      expense({ date: '2032-01-01', amount: 777, merchantRaw: 'Next year' }),
    ],
    memories: [
      memory({ occurredOn: '2030-12-30', title: 'A year earlier' }),
      memory({
        occurredOn: '2031-02-11',
        title: 'Lisbon, the long way round',
        place: 'Lisbon',
      }),
      memory({ occurredOn: '2031-07-03', title: 'A quieter week' }),
      memory({
        occurredOn: '2031-07-15',
        title: 'Sils, and the lake',
        place: 'Sils',
        pinned: true,
      }),
    ],
  }
}

function peopleRows(): Row[] {
  return [
    { ID: ADA, name: 'Ada', colour: '#0070F2', isDefault: true },
    { ID: BRUNO, name: 'Bruno', colour: '#F31DED', isDefault: true },
    { ID: NOEMI, name: 'Noemi', colour: '#049F9A', isDefault: false },
  ]
}

function event(seed: { ID: string; name: string; startsOn: string; endsOn?: string }): Row {
  return {
    ID: seed.ID,
    name: seed.name,
    startsOn: seed.startsOn,
    // Absent for a single-day event, which is the nullable case.
    ...(seed.endsOn === undefined ? {} : { endsOn: seed.endsOn }),
  }
}

function expense(seed: ExpenseSeed): Row {
  const merchantRaw = seed.merchantRaw ?? 'Some Shop'
  return {
    ID: nextId('e'),
    date: seed.date,
    amount: seed.amount,
    currency: seed.currency ?? 'CHF',
    category_code: seed.category ?? 'Dining',
    moment: seed.moment ?? 'everyday',
    merchantRaw,
    merchantNorm: seed.merchantNorm ?? merchantRaw.toLowerCase(),
    paidBy_ID: seed.paidBy ?? ADA,
    event_ID: seed.event ?? null,
    place: seed.place ?? 'Zürich',
    status: seed.status ?? 'confirmed',
    source: 'manual',
  }
}

function memory(seed: MemorySeed): Row {
  return {
    ID: nextId('d'),
    occurredOn: seed.occurredOn,
    title: seed.title,
    place: seed.place ?? 'Zürich',
    pinned: seed.pinned ?? false,
    kind: 'other',
  }
}

/**
 * Sequential ids, so that two rows sharing a date still have a stable order —
 * `aggregateYear()` breaks ties on the key, and the 14 March dinner has to come
 * before the taxi home.
 */
let sequence = 0
function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

// ---------------------------------------------------------------------------
// Test database
// ---------------------------------------------------------------------------

/** Children first, so nothing is ever left pointing at a row that has gone. */
const ENTITIES = [
  'twowaymatch.EventParticipants',
  'twowaymatch.Expenses',
  'twowaymatch.Memories',
  'twowaymatch.Events',
  'twowaymatch.People',
] as const

/** Clears the tables the statement reads and inserts the given rows. */
async function reseed(seed: Seed): Promise<void> {
  for (const entity of ENTITIES) await db.run({ DELETE: { from: { ref: [entity] } } })
  await insert('twowaymatch.People', seed.people ?? [])
  await insert('twowaymatch.Events', seed.events ?? [])
  await insert('twowaymatch.EventParticipants', seed.participants ?? [])
  await insert('twowaymatch.Expenses', seed.expenses ?? [])
  await insert('twowaymatch.Memories', seed.memories ?? [])
}

async function insert(entity: string, entries: Row[]): Promise<void> {
  if (entries.length === 0) return
  await db.run({ INSERT: { into: { ref: [entity] }, entries } })
}

/**
 * `db/schema.cds` on a throwaway in-memory SQLite.
 *
 * `cds.deploy()` is missing from the declarations `@sap/cds` ships, so
 * `import cds from '@sap/cds'` compiles and then fails on `cds.deploy` with
 * TS2339. The module is therefore loaded through an indirect specifier — which
 * TypeScript leaves untyped rather than mis-typed — and narrowed by hand to the
 * two methods actually used. The deploy seeds `db/data/*.csv` on the way in;
 * every test calls `reseed()` first, which clears it.
 */
const CDS_MODULE = '@sap/cds'

interface CdsLike {
  deploy(model: string): { to(url: string): Promise<unknown> }
}

async function deployTestDb(): Promise<StatementDb> {
  const loaded: unknown = await import(CDS_MODULE)
  const cds = isRecord(loaded) && isCds(loaded.default) ? loaded.default : loaded
  if (!isCds(cds)) throw new Error('@sap/cds did not export a deploy()')

  const deployed: unknown = await cds.deploy('db/schema.cds').to('sqlite::memory:')
  if (!isDb(deployed)) throw new Error('cds.deploy() did not return a database service')
  return deployed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCds(value: unknown): value is CdsLike {
  return isRecord(value) && typeof value.deploy === 'function'
}

function isDb(value: unknown): value is StatementDb {
  return isRecord(value) && typeof value.run === 'function'
}
