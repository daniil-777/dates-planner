/// <reference types="@cap-js/cds-types" />
/**
 * LedgerService — behaviour tests.
 *
 * ## How this bootstraps
 *
 * In-process, exactly as `cds.test` does it: load the model, deploy it to a
 * throwaway in-memory SQLite (which also loads `db/data/*.csv`), and construct
 * the service with our own implementation class. No HTTP server, no `db.sqlite`
 * on disk, nothing shared with the developer's dev database.
 *
 * `cds.test` itself lives in `@cap-js/cds-test`, which is not among this repo's
 * dependencies — so the four lines it would have written are written out here
 * instead. The result is the same object: a real `LedgerService` with real
 * handlers, dispatching real CQN against a real database.
 *
 * ## What is asserted, and what is not
 *
 * Nobody owes anybody (CONTRACTS §9), so there is nothing here about balances,
 * netting or who should pay whom. What is asserted instead is that a sum is a
 * sum: what a month came to, what a trip came to, who paid for it, and that
 * closing a period changes none of those numbers.
 *
 * ## How the tests stay independent
 *
 * `beforeEach` re-deploys the schema and re-loads the seed CSVs into the *same*
 * database service. Every test therefore starts from the pristine seed — 5
 * people, 2 events, 19 postings — no matter what the test before it posted,
 * closed or deleted, which is what lets this file assert exact document numbers
 * and exact totals without caring about ordering.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import LedgerServiceImpl from '../srv/ledger-service'
import { round2 } from '../srv/lib/money'

/**
 * `generateStatement` picks its provider from the environment (CONTRACTS §7).
 * Cleared here so the test is hermetic: whatever the developer happens to have
 * exported, this file always exercises the deterministic `template` provider and
 * never opens a socket.
 */
for (const key of ['ANTHROPIC_API_KEY', 'LLM_BASE_URL', 'LLM_API_KEY', 'AICORE_SERVICE_KEY']) {
  delete process.env[key]
}

const { DELETE, INSERT, SELECT, UPDATE } = cds.ql

const EXPENSES = 'LedgerService.Expenses'
const SETTLEMENTS = 'LedgerService.Settlements'
const CORRECTIONS = 'LedgerService.Corrections'
const STATEMENTS = 'LedgerService.Statements'
const PEOPLE = 'LedgerService.People'
const EVENTS = 'LedgerService.Events'
const EVENT_PARTICIPANTS = 'LedgerService.EventParticipants'

/** The two seeded members of the household (CONTRACTS §10) — placeholders, not real people. */
const PARTNER_A = 'a0000000-0000-4000-8000-000000000001'
const PARTNER_B = 'b0000000-0000-4000-8000-000000000002'

/** Three seeded guests. They come to things; none of them has ever paid for anything. */
const NOEMI = 'c0000000-0000-4000-8000-000000000003'
const LUCA = 'c0000000-0000-4000-8000-000000000004'
const INES = 'c0000000-0000-4000-8000-000000000005'

/** Four people, three postings, one long weekend. */
const LISBON = 'f0000000-0000-4000-8000-000000000001'
/** Three people, one posting, one evening. */
const DINNER = 'f0000000-0000-4000-8000-000000000002'

/** The first date. `documentNumber` 1, read-only except for its note. */
const DOCUMENT_ONE_ID = 'e0000000-0000-4000-8000-000000000001'

/** The seed stops at document 19, so the next posting is 20. */
const NEXT_DOCUMENT_NUMBER = 20

interface ExpenseRow {
  ID?: string
  documentNumber?: number | null
  status?: string | null
  note?: string | null
  amount?: number | string | null
  currency?: string | null
  category_code?: string | null
  moment?: string | null
  merchantNorm?: string | null
  paidBy_ID?: string | null
  event_ID?: string | null
  settlement_ID?: string | null
}

interface SettlementRow {
  ID?: string
  period?: string | null
  grandTotal?: number | string | null
  status?: string | null
  settledAt?: string | null
  clearingDocument?: string | null
  approvedBy?: string | null
}

interface StatementRow {
  ID?: string
  year?: number | null
  contentMarkdown?: string | null
  generatedAt?: string | null
  engine?: string | null
}

interface CorrectionRow {
  field?: string | null
  predicted?: string | null
  corrected?: string | null
  createdAt?: string | null
  expense_ID?: string | null
}

interface PersonRow {
  ID?: string
  name?: string | null
  colour?: string | null
  isDefault?: boolean | null
}

interface EventRow {
  ID?: string
  name?: string | null
  startsOn?: string | null
  endsOn?: string | null
  place?: string | null
}

interface ParticipantRow {
  event_ID?: string | null
  person_ID?: string | null
}

interface PersonTotalRow {
  personId: string
  name: string
  paid: number
  count: number
  share: number
}

interface PeriodTotalsRow {
  period: string
  grandTotal: number
  count: number
  byPerson: PersonTotalRow[]
}

interface EventTotalsRow {
  eventId: string
  name: string
  grandTotal: number
  perHead: number
  participantCount: number
  count: number
  byPerson: PersonTotalRow[]
}

interface MonthlyTotalRow {
  period: string
  category: string
  total: number
}

/**
 * `cds.deploy(...)` and `cds.serve(...).with(<service class>)` are both real,
 * documented API, but neither is declared by `@cap-js/cds-types` 0.19. Rather
 * than reach for `any`, the two calls are typed here with the exact shape this
 * file uses, and nothing more.
 */
interface CdsBootstrap {
  deploy(model: cds.csn.CSN): {
    to(target: unknown, options?: { silent?: boolean }): Promise<Service>
  }
  serve(name: string): {
    from(model: ReturnType<typeof cds.compile.for.nodejs>): {
      with(impl: unknown): Promise<Service>
    }
  }
}

const bootstrap = cds as unknown as CdsBootstrap

let ledger: Service
let db: Service
/** The raw, un-flattened CSN. `cds.deploy` needs this one; `cds.serve` gets the
 *  Node.js-compiled `cds.model`, exactly as `@sap/cds`'s own bootstrap does. */
let csn: cds.csn.CSN

/** `Decimal(10,2)` comes back as a number or a string depending on the driver. */
function money(value: number | string | null | undefined): number {
  return round2(Number(value ?? 0))
}

/** Creates an expense through the service, so every `before` handler runs. */
async function createExpense(row: Record<string, unknown>): Promise<ExpenseRow> {
  const ID = cds.utils.uuid()
  await ledger.run(INSERT.into(EXPENSES).entries({ ID, ...row }))
  return (await db.run(SELECT.one.from(EXPENSES).where({ ID }))) as ExpenseRow
}

/** Reads a row straight from the database, bypassing the service's handlers. */
async function readExpense(ID: string): Promise<ExpenseRow> {
  return (await db.run(SELECT.one.from(EXPENSES).where({ ID }))) as ExpenseRow
}

async function periodTotals(period: string): Promise<PeriodTotalsRow> {
  return (await ledger.send('periodTotals', { period })) as PeriodTotalsRow
}

async function eventTotals(eventId: string): Promise<EventTotalsRow> {
  return (await ledger.send('eventTotals', { eventId })) as EventTotalsRow
}

/** One person's line out of a totals answer, by id. */
function lineFor(totals: { byPerson: PersonTotalRow[] }, personId: string): PersonTotalRow {
  const line = totals.byPerson.find(row => row.personId === personId)
  if (line === undefined) throw new Error(`${personId} is not on the roster of this answer`)
  return line
}

beforeAll(async () => {
  cds.root = process.cwd()
  // Point the *configured* database at memory before anything can connect to
  // it. `package.json` names `db.sqlite`, and a test that so much as opens the
  // developer's dev database is a test with a loaded gun in it.
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }

  csn = await cds.load(['db', 'srv'])
  const compiled = cds.compile.for.nodejs(csn)
  cds.model = compiled
  db = await bootstrap.deploy(csn).to('db', { silent: true })
  ledger = await bootstrap.serve('LedgerService').from(compiled).with(LedgerServiceImpl)
})

beforeEach(async () => {
  // Drop, recreate, re-seed — on the same connection, so `cds.db` stays valid.
  await bootstrap.deploy(csn).to(db, { silent: true })
})

describe('periodTotals()', () => {
  it('adds a month up and files it under the people who paid', async () => {
    const totals = await periodTotals('2026-04')

    // April 2026: a flight (612.00) and a hotel (384.00) paid by Partner B, and
    // pastéis de Belém (22.40) paid by Partner A.
    expect(totals.period).toBe('2026-04')
    expect(money(totals.grandTotal)).toBe(1018.4)
    expect(totals.count).toBe(3)

    expect(money(lineFor(totals, PARTNER_B).paid)).toBe(996)
    expect(lineFor(totals, PARTNER_B).count).toBe(2)
    expect(money(lineFor(totals, PARTNER_A).paid)).toBe(22.4)
    expect(lineFor(totals, PARTNER_A).count).toBe(1)

    // `share` is a proportion of the month's spend, not a claim on anybody: the
    // two payers between them account for the whole of it.
    expect(lineFor(totals, PARTNER_B).share).toBeCloseTo(996 / 1018.4, 6)
    expect(lineFor(totals, PARTNER_A).share).toBeCloseTo(22.4 / 1018.4, 6)
    const shares = totals.byPerson.reduce((sum, row) => sum + row.share, 0)
    expect(shares).toBeCloseTo(1, 6)
  })

  it('is a roster: somebody who paid for nothing is still on it, at zero', async () => {
    const totals = await periodTotals('2026-04')

    // All five seeded people, not only the two who spent something in April.
    expect(totals.byPerson).toHaveLength(5)
    for (const guest of [NOEMI, LUCA, INES]) {
      expect(money(lineFor(totals, guest).paid)).toBe(0)
      expect(lineFor(totals, guest).count).toBe(0)
      expect(lineFor(totals, guest).share).toBe(0)
    }
  })

  it('sorts by what people paid, then by name', async () => {
    const totals = await periodTotals('2026-04')

    expect(totals.byPerson.map(row => row.name)).toEqual([
      'Partner B',
      'Partner A',
      'Ines Almeida',
      'Luca Ferrari',
      'Noemi Berger',
    ])
  })

  it('reports a month that nothing was spent in as zero, never as NaN', async () => {
    const totals = await periodTotals('2020-03')

    expect(money(totals.grandTotal)).toBe(0)
    expect(totals.count).toBe(0)
    expect(totals.byPerson).toHaveLength(5)
    for (const row of totals.byPerson) {
      expect(Number.isNaN(row.share)).toBe(false)
      expect(row.share).toBe(0)
    }
  })

  it('ignores drafts — an unposted receipt is not spending yet', async () => {
    const before = await periodTotals('2026-09')
    await createExpense({
      date: '2026-09-20',
      merchantRaw: 'DRAFT ONLY BAR',
      amount: 200,
      paidBy_ID: PARTNER_A,
    })
    const after = await periodTotals('2026-09')

    expect(money(after.grandTotal)).toBe(money(before.grandTotal))
    expect(after.count).toBe(before.count)
  })

  it('counts a posting nobody has been credited with, under nobody', async () => {
    // A confirmed row with no `paidBy` is money that was spent — it belongs in
    // the month's total, and to nobody's line. Dropping it would also put
    // `periodTotals` and `monthlyTotals` at odds on the same screen.
    const before = await periodTotals('2026-09')
    await createExpense({
      date: '2026-09-30',
      merchantRaw: 'PARKHAUS HOHE PROMENADE',
      amount: 14,
      status: 'confirmed',
    })
    const after = await periodTotals('2026-09')

    expect(money(after.grandTotal)).toBe(money(before.grandTotal) + 14)
    expect(after.count).toBe(before.count + 1)
    expect(after.byPerson).toHaveLength(5)
    for (const row of after.byPerson) {
      expect(row.personId).not.toBe('')
    }
    // Every person's own figure is untouched: the amount is in the total and in
    // nobody's column.
    expect(after.byPerson.map(row => row.paid)).toEqual(before.byPerson.map(row => row.paid))
  })

  it('answers with sums and nothing that could be read as a claim', async () => {
    const totals = await periodTotals('2026-04')

    // The exact shape of CONTRACTS §9 / FRONTEND-CONTRACT §2, asserted as a
    // whole rather than field by field: anything this answer grew that the
    // contract does not name — a direction, a position, a figure one person is
    // supposed to hand another — fails here.
    expect(Object.keys(totals).sort()).toEqual(['byPerson', 'count', 'grandTotal', 'period'])
    for (const row of totals.byPerson) {
      expect(Object.keys(row).sort()).toEqual(['count', 'name', 'paid', 'personId', 'share'])
    }
  })

  it('refuses a period that is not YYYY-MM', async () => {
    await expect(ledger.send('periodTotals', { period: 'April' })).rejects.toThrow(
      /must be a period of the form YYYY-MM/,
    )
    await expect(ledger.send('periodTotals', { period: '2026-13' })).rejects.toThrow(
      /must be a period of the form YYYY-MM/,
    )
  })
})

describe('eventTotals()', () => {
  it('totals a trip over the people who were on it', async () => {
    const totals = await eventTotals(LISBON)

    expect(totals.name).toBe('Lisbon Weekend')
    // Flight 612.00 + hotel 384.00 + pastéis 22.40.
    expect(money(totals.grandTotal)).toBe(1018.4)
    expect(totals.count).toBe(3)
    expect(totals.participantCount).toBe(4)
    // Context for the screen — "CHF 254.60 each" — and not a bill anybody is sent.
    expect(money(totals.perHead)).toBe(254.6)

    expect(totals.byPerson).toHaveLength(4)
    expect(money(lineFor(totals, PARTNER_B).paid)).toBe(996)
    expect(money(lineFor(totals, PARTNER_A).paid)).toBe(22.4)
    expect(money(lineFor(totals, NOEMI).paid)).toBe(0)
    expect(money(lineFor(totals, LUCA).paid)).toBe(0)
  })

  it('divides by the people on the event, not by everybody in the ledger', async () => {
    const totals = await eventTotals(DINNER)

    expect(totals.name).toBe('Kronenhalle Dinner')
    expect(money(totals.grandTotal)).toBe(214)
    expect(totals.participantCount).toBe(3)
    // 214.00 / 3 = 71.333…, rounded once, at the end.
    expect(money(totals.perHead)).toBe(71.33)
    expect(totals.byPerson.map(row => row.personId).sort()).toEqual(
      [PARTNER_A, PARTNER_B, INES].sort(),
    )
  })

  it('counts a posting toward its event and its month alike', async () => {
    // The Kronenhalle dinner is 214.00 of June's 275.35. Belonging to an event
    // does not take an expense out of its period — an event is a second way of
    // looking at the same money, never a second ledger.
    const june = await periodTotals('2026-06')
    const dinner = await eventTotals(DINNER)

    expect(money(june.grandTotal)).toBe(275.35)
    expect(money(dinner.grandTotal)).toBe(214)
  })

  it('reports an event nobody is on yet as zero rather than as infinity', async () => {
    const ID = cds.utils.uuid()
    await ledger.run(
      INSERT.into(EVENTS).entries({ ID, name: 'Nothing planned yet', startsOn: '2026-11-01' }),
    )

    const totals = await eventTotals(ID)
    expect(totals.participantCount).toBe(0)
    expect(money(totals.grandTotal)).toBe(0)
    expect(money(totals.perHead)).toBe(0)
    expect(Number.isFinite(totals.perHead)).toBe(true)
    expect(totals.byPerson).toEqual([])
  })

  it('refuses an event that is not in the ledger', async () => {
    await expect(
      ledger.send('eventTotals', { eventId: '00000000-0000-4000-8000-00000000dead' }),
    ).rejects.toThrow(/no event with ID/i)
  })
})

describe('events', () => {
  it('creates an event with its guest list in one payload', async () => {
    const ID = cds.utils.uuid()
    await ledger.run(
      INSERT.into(EVENTS).entries({
        ID,
        name: 'Sunday lunch',
        startsOn: '2026-10-04',
        place: 'Zürich',
        participants: [{ person_ID: PARTNER_A }, { person_ID: PARTNER_B }, { person_ID: INES }],
      }),
    )

    const participants = (await db.run(
      SELECT.from(EVENT_PARTICIPANTS).where({ event_ID: ID }),
    )) as ParticipantRow[]
    expect(participants.map(row => row.person_ID).sort()).toEqual(
      [PARTNER_A, PARTNER_B, INES].sort(),
    )
    expect((await eventTotals(ID)).participantCount).toBe(3)
  })

  it('refuses a guest list with somebody the ledger has never heard of', async () => {
    await expect(
      ledger.run(
        INSERT.into(EVENTS).entries({
          ID: cds.utils.uuid(),
          name: 'Imaginary friends',
          startsOn: '2026-10-04',
          participants: [{ person_ID: '00000000-0000-4000-8000-00000000beef' }],
        }),
      ),
    ).rejects.toThrow(/there is nobody in the ledger with ID/)
  })

  it('refuses the same person twice on one event', async () => {
    await expect(
      ledger.run(
        INSERT.into(EVENTS).entries({
          ID: cds.utils.uuid(),
          name: 'Seeing double',
          startsOn: '2026-10-04',
          participants: [{ person_ID: PARTNER_A }, { person_ID: PARTNER_A }],
        }),
      ),
    ).rejects.toThrow(/is on this event twice/)
  })

  it('replaces a guest list in place, and validates the new one', async () => {
    await ledger.run(
      UPDATE.entity(EVENTS, DINNER).with({
        participants: [{ person_ID: PARTNER_A }, { person_ID: LUCA }],
      }),
    )

    const totals = await eventTotals(DINNER)
    expect(totals.byPerson.map(row => row.personId).sort()).toEqual([PARTNER_A, LUCA].sort())

    await expect(
      ledger.run(
        UPDATE.entity(EVENTS, DINNER).with({
          participants: [{ person_ID: '00000000-0000-4000-8000-00000000beef' }],
        }),
      ),
    ).rejects.toThrow(/there is nobody in the ledger with ID/)
  })

  it('adds one person to an event that already exists', async () => {
    await ledger.run(INSERT.into(EVENT_PARTICIPANTS).entries({ event_ID: DINNER, person_ID: LUCA }))

    const totals = await eventTotals(DINNER)
    expect(totals.participantCount).toBe(4)
    expect(money(totals.perHead)).toBe(53.5)
  })

  it('refuses a participant on an event that does not exist', async () => {
    await expect(
      ledger.run(
        INSERT.into(EVENT_PARTICIPANTS).entries({
          event_ID: '00000000-0000-4000-8000-00000000f00d',
          person_ID: LUCA,
        }),
      ),
    ).rejects.toThrow(/no event with ID/i)
  })

  it('lets an expense point at an event that exists, and nothing else', async () => {
    const attached = await createExpense({
      date: '2026-04-12',
      merchantRaw: 'TRAM 28 LISBOA',
      amount: 3.2,
      paidBy_ID: PARTNER_A,
      event_ID: LISBON,
    })
    expect(attached.event_ID).toBe(LISBON)

    await expect(
      createExpense({
        date: '2026-04-12',
        merchantRaw: 'ELEVADOR DA BICA',
        amount: 3.8,
        paidBy_ID: PARTNER_A,
        event_ID: '00000000-0000-4000-8000-00000000beef',
      }),
    ).rejects.toThrow(/there is no event with ID/)
  })

  it('detaches its expenses when it is deleted, and never deletes them', async () => {
    const before = (await db.run(SELECT.from(EXPENSES).where({ event_ID: LISBON }))) as ExpenseRow[]
    expect(before).toHaveLength(3)

    await ledger.run(DELETE.from(EVENTS, LISBON))

    // The trip is gone; the money that was spent on it is not.
    expect(await db.run(SELECT.one.from(EVENTS).where({ ID: LISBON }))).toBeUndefined()
    const after = (await db.run(
      SELECT.from(EXPENSES).where({ ID: { in: before.map(row => String(row.ID)) } }),
    )) as ExpenseRow[]
    expect(after).toHaveLength(3)
    for (const row of after) expect(row.event_ID).toBeNull()

    // …and April still totals exactly what it did, because an event was only
    // ever a second way of looking at the same postings.
    expect(money((await periodTotals('2026-04')).grandTotal)).toBe(1018.4)

    // The guest list goes with the event: it was a fact about a pairing.
    const orphans = (await db.run(
      SELECT.from(EVENT_PARTICIPANTS).where({ event_ID: LISBON }),
    )) as ParticipantRow[]
    expect(orphans).toHaveLength(0)
  })
})

describe('people', () => {
  it('refuses to delete somebody who has paid for something', async () => {
    await expect(ledger.run(DELETE.from(PEOPLE, PARTNER_A))).rejects.toThrow(
      /Partner A \(9 postings\) cannot be removed/,
    )

    expect(await db.run(SELECT.one.from(PEOPLE).where({ ID: PARTNER_A }))).toBeTruthy()
    expect(await db.run(SELECT.from(EXPENSES).where({ paidBy_ID: PARTNER_A }))).toHaveLength(9)
  })

  it('deletes somebody who never paid for anything, guest list and all', async () => {
    await ledger.run(DELETE.from(PEOPLE, NOEMI))

    expect(await db.run(SELECT.one.from(PEOPLE).where({ ID: NOEMI }))).toBeUndefined()
    expect(await db.run(SELECT.from(PEOPLE))).toHaveLength(4)

    // Noemi was on the Lisbon weekend, which is now a trip for three.
    const totals = await eventTotals(LISBON)
    expect(totals.participantCount).toBe(3)
    expect(totals.byPerson.map(row => row.personId)).not.toContain(NOEMI)
  })

  it('takes as many people as the household has, not two', async () => {
    const ID = cds.utils.uuid()
    await ledger.run(
      INSERT.into(PEOPLE).entries({ ID, name: 'Sofia Marti', colour: '#256F3A', email: null }),
    )
    await createExpense({
      date: '2026-09-05',
      merchantRaw: 'BAECKEREI HUG',
      amount: 12.5,
      paidBy_ID: ID,
      status: 'confirmed',
    })

    const totals = await periodTotals('2026-09')
    expect(totals.byPerson).toHaveLength(6)
    expect(money(lineFor(totals, ID).paid)).toBe(12.5)
    expect(money(totals.grandTotal)).toBe(132.5)
  })
})

describe('confirmExpense()', () => {
  it('posts drafts with sequential document numbers', async () => {
    const first = await createExpense({
      date: '2026-09-10',
      merchantRaw: 'BAECKEREI HUG',
      amount: 12.5,
      paidBy_ID: PARTNER_A,
    })
    const second = await createExpense({
      date: '2026-09-11',
      merchantRaw: 'KIOSK HAUPTBAHNHOF',
      amount: 8.4,
      paidBy_ID: PARTNER_B,
    })
    expect(first.status).toBe('draft')
    expect(first.documentNumber).toBeNull()

    const posted = (await ledger.send('confirmExpense', {
      ID: first.ID,
      predictedCategory: '',
      predictedMoment: '',
    })) as ExpenseRow
    const alsoPosted = (await ledger.send('confirmExpense', {
      ID: second.ID,
      predictedCategory: '',
      predictedMoment: '',
    })) as ExpenseRow

    expect(posted.status).toBe('confirmed')
    expect(posted.documentNumber).toBe(NEXT_DOCUMENT_NUMBER)
    expect(alsoPosted.documentNumber).toBe(NEXT_DOCUMENT_NUMBER + 1)
  })

  it('keeps the document number it already has when confirmed twice', async () => {
    const draft = await createExpense({
      date: '2026-09-12',
      merchantRaw: 'VOLG DORFLADEN',
      amount: 21.3,
      paidBy_ID: PARTNER_A,
    })
    const once = (await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: '',
      predictedMoment: '',
    })) as ExpenseRow
    const twice = (await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: '',
      predictedMoment: '',
    })) as ExpenseRow

    expect(twice.documentNumber).toBe(once.documentNumber)
  })

  it('brings a posting into its period as soon as it is confirmed', async () => {
    const before = await periodTotals('2026-09')
    const draft = await createExpense({
      date: '2026-09-24',
      merchantRaw: 'VOLG DORFLADEN',
      amount: 21.3,
      paidBy_ID: NOEMI,
    })

    await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: '',
      predictedMoment: '',
    })

    const after = await periodTotals('2026-09')
    expect(money(after.grandTotal)).toBe(money(before.grandTotal) + 21.3)
    expect(money(lineFor(after, NOEMI).paid)).toBe(21.3)
  })

  it('logs a Correction for every head the human overruled', async () => {
    const draft = await createExpense({
      date: '2026-09-13',
      merchantRaw: 'RESTAURANT KRONENHALLE',
      amount: 180,
      paidBy_ID: PARTNER_B,
      category_code: 'Dining',
      moment: 'date_night',
    })

    await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: 'Groceries',
      predictedMoment: 'everyday',
    })

    const corrections = (await db.run(
      SELECT.from(CORRECTIONS).where({ expense_ID: draft.ID }),
    )) as CorrectionRow[]
    const byField = new Map(corrections.map(row => [row.field, row]))

    expect(corrections).toHaveLength(2)
    expect(byField.get('category')).toMatchObject({
      predicted: 'Groceries',
      corrected: 'Dining',
    })
    expect(byField.get('moment')).toMatchObject({
      predicted: 'everyday',
      corrected: 'date_night',
    })
    // `@cds.on.insert: $now` stamps this; the handler must not send it itself.
    expect(byField.get('category')?.createdAt).toBeTruthy()
  })

  it('logs nothing when the model was right', async () => {
    const draft = await createExpense({
      date: '2026-09-14',
      merchantRaw: 'MIGROS ZUERICH HB',
      amount: 44.2,
      paidBy_ID: PARTNER_A,
      category_code: 'Groceries',
      moment: 'everyday',
    })

    await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: 'Groceries',
      predictedMoment: 'everyday',
    })

    const corrections = (await db.run(
      SELECT.from(CORRECTIONS).where({ expense_ID: draft.ID }),
    )) as CorrectionRow[]
    expect(corrections).toHaveLength(0)
  })

  it('does not log the same correction twice when a post is repeated', async () => {
    const draft = await createExpense({
      date: '2026-09-13',
      merchantRaw: 'RESTAURANT KRONENHALLE',
      amount: 180,
      paidBy_ID: PARTNER_B,
      category_code: 'Dining',
      moment: 'date_night',
    })
    const post = async () =>
      ledger.send('confirmExpense', {
        ID: draft.ID,
        predictedCategory: 'Groceries',
        predictedMoment: 'everyday',
      })

    // A double tap on "Post", or a client retrying a request whose response it
    // never saw. Posting is idempotent, so the training log has to be too:
    // duplicated rows would weight this one disagreement double at the next
    // training round.
    await post()
    await post()
    await post()

    const corrections = (await db.run(
      SELECT.from(CORRECTIONS).where({ expense_ID: draft.ID }),
    )) as CorrectionRow[]
    expect(corrections).toHaveLength(2)
  })

  it('still logs a correction that is genuinely new', async () => {
    const draft = await createExpense({
      date: '2026-09-13',
      merchantRaw: 'RESTAURANT KRONENHALLE',
      amount: 180,
      paidBy_ID: PARTNER_B,
      category_code: 'Dining',
      moment: 'date_night',
    })

    await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: 'Groceries',
      predictedMoment: 'everyday',
    })
    // A different prediction is a different fact about the model, so it is kept
    // alongside the first rather than swallowed by the de-duplication.
    await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: 'Cafes',
      predictedMoment: 'everyday',
    })

    const corrections = (await db.run(
      SELECT.from(CORRECTIONS).where({ expense_ID: draft.ID }),
    )) as CorrectionRow[]
    expect(corrections).toHaveLength(3)
    expect(
      corrections
        .filter(row => row.field === 'category')
        .map(row => row.predicted)
        .sort(),
    ).toEqual(['Cafes', 'Groceries'])
  })

  it('refuses an ID that is not in the ledger', async () => {
    await expect(
      ledger.send('confirmExpense', {
        ID: '00000000-0000-4000-8000-00000000dead',
        predictedCategory: '',
        predictedMoment: '',
      }),
    ).rejects.toThrow(/no expense with ID/i)
  })
})

describe('runSettlement() and markSettled()', () => {
  it('closes a period into a clearing document and links its lines', async () => {
    const settlement = (await ledger.send('runSettlement', { period: '2026-01' })) as SettlementRow

    expect(settlement.clearingDocument).toBe('CLR-2026-01')
    expect(settlement.period).toBe('2026-01')
    expect(settlement.status).toBe('open')
    expect(settlement.approvedBy).toBe('CEO of the household')
    // 2026-01 holds exactly two seeded expenses: 87.45 and 148.50.
    expect(money(settlement.grandTotal)).toBe(235.95)

    const covered = (await db.run(
      SELECT.from(EXPENSES).where({ settlement_ID: settlement.ID }),
    )) as ExpenseRow[]
    expect(covered).toHaveLength(2)
  })

  it('records what the month came to and moves nothing', async () => {
    const before = await periodTotals('2026-01')
    const settlement = (await ledger.send('runSettlement', { period: '2026-01' })) as SettlementRow
    const after = await periodTotals('2026-01')

    // The close is a report, not a transfer: the same month, closed, totals
    // exactly what it totalled open, person by person.
    expect(money(settlement.grandTotal)).toBe(money(before.grandTotal))
    expect(after).toEqual(before)

    // And the clearing document itself is one figure and some paperwork —
    // asserted as a whole key set, so a column that says who should pay whom
    // cannot creep back in unnoticed.
    expect(Object.keys(settlement).sort()).toEqual([
      'ID',
      'approvedBy',
      'clearingDocument',
      'createdAt',
      'createdBy',
      'grandTotal',
      'modifiedAt',
      'modifiedBy',
      'period',
      'settledAt',
      'status',
    ])
  })

  it('closes a period exactly once', async () => {
    await ledger.send('runSettlement', { period: '2026-01' })
    await expect(ledger.send('runSettlement', { period: '2026-01' })).rejects.toThrow(
      /already been closed by CLR-2026-01/,
    )
  })

  it('refuses a period with nothing left to close', async () => {
    await expect(ledger.send('runSettlement', { period: '2020-03' })).rejects.toThrow(
      /nothing to close in 2020-03/,
    )
  })

  it('refuses a period that is not YYYY-MM', async () => {
    await expect(ledger.send('runSettlement', { period: 'January' })).rejects.toThrow(
      /must be a period of the form YYYY-MM/,
    )
    await expect(ledger.send('runSettlement', { period: '2026-13' })).rejects.toThrow(
      /must be a period of the form YYYY-MM/,
    )
  })

  it('marks a closed period settled, once', async () => {
    const settlement = (await ledger.send('runSettlement', { period: '2026-02' })) as SettlementRow

    const settled = (await ledger.send('markSettled', { ID: settlement.ID })) as SettlementRow
    expect(settled.status).toBe('settled')
    expect(settled.settledAt).toBeTruthy()

    await expect(ledger.send('markSettled', { ID: settlement.ID })).rejects.toThrow(
      /already settled/,
    )
  })

  it('refuses to settle a clearing document that does not exist', async () => {
    await expect(
      ledger.send('markSettled', { ID: '00000000-0000-4000-8000-00000000beef' }),
    ).rejects.toThrow(/no clearing document with ID/i)
  })

  it('leaves Document #1 out of the payment run entirely', async () => {
    // June 2024 contains exactly one confirmed, open expense: the first date, at
    // CHF 0.00. Closing it would write a `settlement` onto the one row
    // CONTRACTS §10 declares read-only, in exchange for a clearing document
    // covering nothing. The run is refused instead, and Document #1 is untouched.
    await expect(ledger.send('runSettlement', { period: '2024-06' })).rejects.toThrow(
      /nothing to close in 2024-06/,
    )

    expect((await readExpense(DOCUMENT_ONE_ID)).settlement_ID).toBeNull()
    expect(await db.run(SELECT.from(SETTLEMENTS))).toHaveLength(0)
  })

  it('still reports June 2024 as the month it was, Document #1 included', async () => {
    // Left out of the *close*, never out of the *report*: it is a posting, and a
    // CHF 0.00 posting changes no total anyway.
    const totals = await periodTotals('2024-06')

    expect(totals.count).toBe(1)
    expect(money(totals.grandTotal)).toBe(0)
    expect(lineFor(totals, PARTNER_A).count).toBe(1)
  })
})

describe('duplicates()', () => {
  it('finds the same purchase booked twice, and nothing else', async () => {
    const original = await createExpense({
      date: '2026-09-10',
      merchantRaw: 'BAECKEREI HUG',
      amount: 12.5,
      paidBy_ID: PARTNER_A,
    })
    const nearlyIdentical = await createExpense({
      date: '2026-09-11',
      merchantRaw: 'BAECKEREI HUG',
      amount: 12.53,
      paidBy_ID: PARTNER_A,
    })
    // Same merchant and amount, but eleven days later.
    await createExpense({
      date: '2026-09-21',
      merchantRaw: 'BAECKEREI HUG',
      amount: 12.5,
      paidBy_ID: PARTNER_A,
    })
    // Same merchant and day, but 7.50 more expensive.
    await createExpense({
      date: '2026-09-10',
      merchantRaw: 'BAECKEREI HUG',
      amount: 20,
      paidBy_ID: PARTNER_A,
    })
    // Same day and amount, different merchant.
    await createExpense({
      date: '2026-09-10',
      merchantRaw: 'BAECKEREI FLEISCHLI',
      amount: 12.5,
      paidBy_ID: PARTNER_A,
    })

    const found = (await ledger.send('duplicates', { ID: original.ID })) as ExpenseRow[]

    expect(found.map(row => row.ID)).toEqual([nearlyIdentical.ID])
  })

  it('normalises the merchant before comparing it', async () => {
    const original = await createExpense({
      date: '2026-09-15',
      merchantRaw: 'CAFÉ SPRÜNGLI 12.09.26',
      amount: 18.6,
      paidBy_ID: PARTNER_B,
    })
    const restated = await createExpense({
      date: '2026-09-15',
      merchantRaw: 'cafe spruengli 14.09.26',
      amount: 18.6,
      paidBy_ID: PARTNER_B,
    })

    expect(original.merchantNorm).toBe('cafe spruengli')
    expect(restated.merchantNorm).toBe('cafe spruengli')
    const found = (await ledger.send('duplicates', { ID: original.ID })) as ExpenseRow[]
    expect(found.map(row => row.ID)).toEqual([restated.ID])
  })

  it('includes both edges of the window and nothing past them', async () => {
    // The window is ±0.05 and ±2 calendar days, both inclusive. The four rows
    // below sit exactly on each edge and exactly one step outside it, so an
    // off-by-one in either comparison changes the answer.
    const original = await createExpense({
      date: '2026-09-10',
      merchantRaw: 'BOUNDARY BAKERY',
      amount: 10,
      paidBy_ID: PARTNER_A,
    })
    const onBothEdges = await createExpense({
      date: '2026-09-12',
      merchantRaw: 'BOUNDARY BAKERY',
      amount: 10.05,
      paidBy_ID: PARTNER_A,
    })
    const alsoOnBothEdges = await createExpense({
      date: '2026-09-08',
      merchantRaw: 'BOUNDARY BAKERY',
      amount: 9.95,
      paidBy_ID: PARTNER_A,
    })
    // One rappen too expensive.
    await createExpense({
      date: '2026-09-10',
      merchantRaw: 'BOUNDARY BAKERY',
      amount: 10.06,
      paidBy_ID: PARTNER_A,
    })
    // One day too late.
    await createExpense({
      date: '2026-09-13',
      merchantRaw: 'BOUNDARY BAKERY',
      amount: 10,
      paidBy_ID: PARTNER_A,
    })

    const found = (await ledger.send('duplicates', { ID: original.ID })) as ExpenseRow[]
    expect(found.map(row => row.ID).sort()).toEqual([onBothEdges.ID, alsoOnBothEdges.ID].sort())
  })

  it('refuses an ID that is not in the ledger', async () => {
    await expect(
      ledger.send('duplicates', { ID: '00000000-0000-4000-8000-00000000f00d' }),
    ).rejects.toThrow(/no expense with ID/i)
  })
})

describe('classification', () => {
  it('classifies a new expense that arrives without a category', async () => {
    const created = await createExpense({
      date: '2026-09-16',
      time: '20:15:00',
      merchantRaw: 'RESTAURANT BLAUE ENTE',
      amount: 148.5,
      paidBy_ID: PARTNER_B,
    })

    expect(created.category_code).toBe('Dining')
    expect(created.merchantNorm).toBe('restaurant blaue ente')
    expect(created.moment).toBeTruthy()
  })

  it('leaves a category the human chose alone', async () => {
    const created = await createExpense({
      date: '2026-09-17',
      merchantRaw: 'RESTAURANT BLAUE ENTE',
      amount: 148.5,
      paidBy_ID: PARTNER_B,
      category_code: 'Gifts',
    })

    expect(created.category_code).toBe('Gifts')
  })

  it('re-runs both heads on demand', async () => {
    const created = await createExpense({
      date: '2026-09-18',
      time: '20:15:00',
      merchantRaw: 'RESTAURANT BLAUE ENTE',
      amount: 148.5,
      paidBy_ID: PARTNER_B,
      category_code: 'Gifts',
    })

    const reclassified = (await ledger.send('classify', { ID: created.ID })) as ExpenseRow
    expect(reclassified.category_code).toBe('Dining')
  })
})

describe('monthlyTotals()', () => {
  it('groups confirmed spending by period and category', async () => {
    const totals = (await ledger.send('monthlyTotals', {
      fromPeriod: '2026-04',
      toPeriod: '2026-04',
    })) as MonthlyTotalRow[]

    // April 2026 seeds a flight (612.00) and a hotel (384.00), both Travel, plus
    // pastéis de Belém (22.40) under Cafes.
    expect(totals).toEqual([
      { period: '2026-04', category: 'Cafes', total: 22.4 },
      { period: '2026-04', category: 'Travel', total: 996 },
    ])
  })

  it('refuses a range that runs backwards', async () => {
    await expect(
      ledger.send('monthlyTotals', { fromPeriod: '2026-06', toPeriod: '2026-01' }),
    ).rejects.toThrow(/is after toPeriod/)
  })

  it('refuses a malformed period', async () => {
    await expect(
      ledger.send('monthlyTotals', { fromPeriod: '2026', toPeriod: '2026-12' }),
    ).rejects.toThrow(/must be a period of the form YYYY-MM/)
  })
})

describe('inbound write rules', () => {
  it('rejects an amount that is not greater than zero', async () => {
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'FREE SAMPLE', amount: 0 }),
    ).rejects.toThrow(/amount must be greater than 0/)
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'REFUND', amount: -12.5 }),
    ).rejects.toThrow(/amount must be greater than 0/)
  })

  it('rejects an amount that is not a number at all', async () => {
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'GARBAGE', amount: 'twelve' }),
    ).rejects.toThrow()
  })

  it('rejects a currency that is not three letters', async () => {
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'DUTY FREE', amount: 10, currency: 'CH1' }),
    ).rejects.toThrow(/three-letter ISO-4217 code/)
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'DUTY FREE', amount: 10, currency: 'CH' }),
    ).rejects.toThrow(/three-letter ISO-4217 code/)
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'DUTY FREE', amount: 10, currency: '12' }),
    ).rejects.toThrow(/three-letter ISO-4217 code/)
    // Four characters never reach this rule: `currency` is `String(3)`, so CAP's
    // own length check refuses the payload first. It is still refused.
    await expect(
      createExpense({ date: '2026-09-19', merchantRaw: 'DUTY FREE', amount: 10, currency: 'CHFR' }),
    ).rejects.toThrow()
  })

  it('stores a currency in its canonical upper case, whatever the client sent', async () => {
    // The rule is case-insensitive so a client that lower-cases its payload is
    // not turned away — but 'chf' and 'CHF' are one currency, and storing both
    // spellings would have every total, chart and statement count them as two.
    const created = await createExpense({
      date: '2026-09-19',
      merchantRaw: 'DUTY FREE',
      amount: 10,
      currency: 'chf',
      paidBy_ID: PARTNER_A,
    })
    expect(created.currency).toBe('CHF')

    await ledger.run(UPDATE.entity(EXPENSES, created.ID).with({ currency: 'eur' }))
    expect((await readExpense(String(created.ID))).currency).toBe('EUR')
  })

  it('refuses to put a draft into a clearing document', async () => {
    const settlement = (await ledger.send('runSettlement', { period: '2026-03' })) as SettlementRow
    const draft = await createExpense({
      date: '2026-03-04',
      merchantRaw: 'LATE ARRIVAL GMBH',
      amount: 30,
      paidBy_ID: PARTNER_A,
    })

    await expect(
      ledger.run(UPDATE.entity(EXPENSES, draft.ID).with({ settlement_ID: settlement.ID })),
    ).rejects.toThrow(/a draft cannot be closed/)
  })

  it('allows a confirmed expense into a clearing document', async () => {
    const settlement = (await ledger.send('runSettlement', { period: '2026-03' })) as SettlementRow
    const draft = await createExpense({
      date: '2026-03-04',
      merchantRaw: 'LATE ARRIVAL GMBH',
      amount: 30,
      paidBy_ID: PARTNER_A,
    })
    await ledger.send('confirmExpense', {
      ID: draft.ID,
      predictedCategory: '',
      predictedMoment: '',
    })

    await ledger.run(UPDATE.entity(EXPENSES, draft.ID).with({ settlement_ID: settlement.ID }))
    expect((await readExpense(String(draft.ID))).settlement_ID).toBe(settlement.ID)
  })

  it('applies the amount rule to writes only, never to what is already stored', async () => {
    // Document #1 is seeded with 0.00 and must stay readable and postable data.
    const documentOne = await readExpense(DOCUMENT_ONE_ID)
    expect(money(documentOne.amount)).toBe(0)
    expect(documentOne.status).toBe('confirmed')
  })
})

describe('Document #1', () => {
  it('accepts a new note', async () => {
    const note = 'Still the best line item in the book.'
    await ledger.run(UPDATE.entity(EXPENSES, DOCUMENT_ONE_ID).with({ note }))

    expect((await readExpense(DOCUMENT_ONE_ID)).note).toBe(note)
  })

  it('rejects a change to its amount', async () => {
    await expect(
      ledger.run(UPDATE.entity(EXPENSES, DOCUMENT_ONE_ID).with({ amount: 42 })),
    ).rejects.toThrow(/Document #1 is read-only except for its note/)

    expect(money((await readExpense(DOCUMENT_ONE_ID)).amount)).toBe(0)
  })

  it('rejects a change to anything else, including alongside a legal note', async () => {
    await expect(
      ledger.run(
        UPDATE.entity(EXPENSES, DOCUMENT_ONE_ID).with({ note: 'sneaky', merchantRaw: 'ELSEWHERE' }),
      ),
    ).rejects.toThrow(/cannot change merchantRaw/)

    await expect(
      ledger.run(UPDATE.entity(EXPENSES, DOCUMENT_ONE_ID).with({ status: 'draft' })),
    ).rejects.toThrow(/Document #1 is read-only/)
  })

  it('cannot be moved onto an event either', async () => {
    await expect(
      ledger.run(UPDATE.entity(EXPENSES, DOCUMENT_ONE_ID).with({ event_ID: DINNER })),
    ).rejects.toThrow(/cannot change event_ID/)
  })

  it('cannot be deleted', async () => {
    await expect(ledger.run(DELETE.from(EXPENSES, DOCUMENT_ONE_ID))).rejects.toThrow(
      /Document #1 is read-only and cannot be deleted/,
    )

    expect(await readExpense(DOCUMENT_ONE_ID)).toBeTruthy()
  })

  it('cannot be re-posted or reclassified', async () => {
    await expect(
      ledger.send('confirmExpense', {
        ID: DOCUMENT_ONE_ID,
        predictedCategory: '',
        predictedMoment: '',
      }),
    ).rejects.toThrow(/Document #1 is read-only/)

    await expect(ledger.send('classify', { ID: DOCUMENT_ONE_ID })).rejects.toThrow(
      /Document #1 is read-only/,
    )
  })

  it('leaves every other expense freely editable', async () => {
    const other = 'e0000000-0000-4000-8000-000000000003'
    await ledger.run(UPDATE.entity(EXPENSES, other).with({ note: 'Reservation confirmed.' }))
    expect((await readExpense(other)).note).toBe('Reservation confirmed.')
  })
})

describe('generateStatement()', () => {
  it('writes a statement and regenerates it in place', async () => {
    const first = (await ledger.send('generateStatement', { year: 2026 })) as StatementRow

    expect(first.year).toBe(2026)
    // No credentials are configured, so the deterministic renderer answers —
    // which is the point of CONTRACTS §7's last step: the feature never needs one.
    expect(first.engine).toBe('template')
    expect(String(first.contentMarkdown)).toContain('Statement of Us')
    expect(first.generatedAt).toBeTruthy()

    const again = (await ledger.send('generateStatement', { year: 2026 })) as StatementRow
    expect(again.ID).toBe(first.ID)

    const stored = (await db.run(SELECT.from(STATEMENTS))) as StatementRow[]
    expect(stored).toHaveLength(1)
  })

  it('refuses something that is not a calendar year', async () => {
    await expect(ledger.send('generateStatement', { year: 26 })).rejects.toThrow(
      /four-digit calendar year/,
    )
  })
})

describe('bulk writes', () => {
  it('validates every row of a multi-row insert, not just the first', async () => {
    await expect(
      ledger.run(
        INSERT.into(EXPENSES).entries([
          {
            ID: cds.utils.uuid(),
            date: '2026-09-22',
            merchantRaw: 'HONEST ROW',
            amount: 10,
            paidBy_ID: PARTNER_A,
          },
          {
            ID: cds.utils.uuid(),
            date: '2026-09-22',
            merchantRaw: 'IMPOSSIBLE ROW',
            amount: -1,
            paidBy_ID: PARTNER_A,
          },
        ]),
      ),
    ).rejects.toThrow(/amount must be greater than 0/)

    const rows = (await db.run(SELECT.from(EXPENSES))) as ExpenseRow[]
    expect(rows).toHaveLength(19)
  })

  it('will not let a filtered delete sweep up Document #1', async () => {
    await expect(ledger.run(DELETE.from(EXPENSES).where({ date: '2024-06-15' }))).rejects.toThrow(
      /Document #1 is read-only and cannot be deleted/,
    )

    expect(await readExpense(DOCUMENT_ONE_ID)).toBeTruthy()
  })

  it('will not let a filtered update reach Document #1 either', async () => {
    // The same filter, in the other kind of statement: `UPDATE.entity(X).where(…)`
    // keeps its filter one level up from `req.subject`, so a guard that read only
    // the subject would think this request touched every expense — or none.
    await expect(
      ledger.run(UPDATE.entity(EXPENSES).where({ date: '2024-06-15' }).with({ amount: 42 })),
    ).rejects.toThrow(/Document #1 is read-only except for its note/)

    expect(money((await readExpense(DOCUMENT_ONE_ID)).amount)).toBe(0)
  })

  it('lets a filtered update through when Document #1 is not in it', async () => {
    await ledger.run(
      UPDATE.entity(EXPENSES).where({ date: '2026-01-11' }).with({ note: 'Reconciled.' }),
    )

    expect((await readExpense('e0000000-0000-4000-8000-000000000002')).note).toBe('Reconciled.')
  })

  it('refuses a filtered delete of people who have postings, and takes nobody with it', async () => {
    await expect(ledger.run(DELETE.from(PEOPLE).where({ isDefault: true }))).rejects.toThrow(
      /cannot be removed/,
    )

    expect(await db.run(SELECT.from(PEOPLE))).toHaveLength(5)
  })
})

describe('the seed itself', () => {
  it('is the ledger every assertion above assumes', async () => {
    const expenses = (await db.run(SELECT.from(EXPENSES))) as ExpenseRow[]
    const settlements = (await db.run(SELECT.from(SETTLEMENTS))) as SettlementRow[]
    const people = (await db.run(SELECT.from(PEOPLE))) as PersonRow[]
    const events = (await db.run(SELECT.from(EVENTS))) as EventRow[]
    const participants = (await db.run(SELECT.from(EVENT_PARTICIPANTS))) as ParticipantRow[]

    expect(expenses).toHaveLength(19)
    expect(settlements).toHaveLength(0)
    expect(expenses.every(row => row.status === 'confirmed')).toBe(true)
    expect(expenses.filter(row => row.documentNumber === 1)).toHaveLength(1)

    // More than two people, and none of them is called A or B by anything but
    // their placeholder name.
    expect(people).toHaveLength(5)
    expect(people.filter(row => row.isDefault === true)).toHaveLength(2)
    expect(people.every(row => typeof row.colour === 'string' && row.colour !== '')).toBe(true)

    // Four events: two behind us, one ahead so nothing "upcoming" is ever empty,
    // and one surprise so §11's hidden path has coverage from the first run.
    // `test/events.test.ts` owns what those two new ones mean.
    expect(events).toHaveLength(4)
    expect(participants).toHaveLength(12)
    // Four postings belong to an event; the other fifteen are everyday spending.
    expect(expenses.filter(row => row.event_ID !== null)).toHaveLength(4)
  })
})
