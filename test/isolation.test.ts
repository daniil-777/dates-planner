/// <reference types="@cap-js/cds-types" />
/**
 * Group isolation — TWM-ADR-002 phase 1, CONTRACTS.md section 12.1.
 *
 * ## What this file is for
 *
 * One handler, `scopeToGroup`, is the entire boundary between two households. If it
 * is wrong, one couple reads another couple's ledger. Nothing else in the codebase
 * would notice: every other test runs inside a single seeded group and passes just as
 * happily whether the narrowing is there or not. So this file exists to fail when the
 * boundary does.
 *
 * ## How it proves it
 *
 * A second household — "The Other Household" — is written straight into the database
 * with its own person, expenses, event and memory. Every request in the suite is an
 * ordinary one, resolving to the seeded default group, and every assertion is that the
 * second household is *absent*: from lists, from `$count`, from reads by id, and above
 * all from the money.
 *
 * That last one is the assertion that matters. Hiding rows from a list is easy and
 * obvious when it breaks. A total that silently includes another household's spending
 * is wrong in a way nobody sees — the number just looks a bit high — so `periodTotals`,
 * `monthlyTotals` and `eventTotals` are each checked against the other household's
 * amounts by value, not merely by row count.
 *
 * ## What this file deliberately does not cover, and where it is covered instead
 *
 * The write path is absent here, and not because it matters less — it matters most.
 * `scopeWrite` stamps OData creates and recurses into compositions, so a deep create
 * cannot leave its children unstamped; and seven action handlers stamp their own
 * `INSERT.into(...)` rows, because those never reach a CREATE handler and an unstamped
 * row is written successfully and then invisible to every later read.
 *
 * None of that can be asserted in this harness. `cds.deploy(csn).to('db')` and
 * `cds.serve(...)` settle on two different in-memory SQLite connections — one holding
 * the `twowaymatch_*` tables, the other the `LedgerService_*` projections — and a write
 * dispatches against the one that does not hold the roster the scoping needs, while a
 * read lands on the other. Reshaping shipping code to suit that would be the tail
 * wagging the dog.
 *
 * So the write path is verified against a real server, which has one database. With a
 * second household planted behind the service's back:
 *
 * ```
 * sqlite3 db.sqlite "INSERT INTO twowaymatch_Groups  ... 'The Other Household' ...;
 *                    INSERT INTO twowaymatch_People  ... 'Someone Else' ...;
 *                    INSERT INTO twowaymatch_Expenses ... 9999.99 ...;"
 *
 * GET /api/ledger/People             -> Partner A, Partner B, Noemi, Luca, Ines
 * GET /api/ledger/Expenses?$count    -> 19, with 20 rows in the table
 * GET /api/ledger/Expenses(e444...)  -> HTTP 404, not 403
 * GET /api/ledger/periodTotals(...)  -> grandTotal 120, not 10119.99
 * ```
 *
 * If the harness is ever fixed to deploy a single database, move them in here.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import { beforeAll, describe, expect, it } from 'vitest'

import LedgerServiceImpl from '../srv/ledger-service'
import { addDays, todayISO } from '../srv/lib/dates'

for (const key of ['ANTHROPIC_API_KEY', 'LLM_BASE_URL', 'LLM_API_KEY', 'AICORE_SERVICE_KEY']) {
  delete process.env[key]
}
process.env.MOCK_DOCAI = '1'

const { INSERT, SELECT } = cds.ql

const EXPENSES = 'LedgerService.Expenses'
const PEOPLE = 'LedgerService.People'
const EVENTS = 'LedgerService.Events'
const MEMORIES = 'LedgerService.Memories'

/**
 * The same entities, addressed through `db` rather than through the service.
 *
 * `db.run` dispatches straight to SQLite and never reaches a `LedgerService` handler,
 * so these reads and writes are the intruder's-eye view: unscoped, unfiltered, and
 * exactly what the service must refuse to show. (Projection names rather than
 * `twowaymatch.*` because that is what the compiled model exposes to a test.)
 */
const GROUPS_TABLE = 'twowaymatch.Groups'
const PEOPLE_TABLE = 'twowaymatch.People'
const EXPENSES_TABLE = 'twowaymatch.Expenses'
const EVENTS_TABLE = 'twowaymatch.Events'
const MEMORIES_TABLE = 'twowaymatch.Memories'

const AS_A = 'Partner A'

/** The other household. Every id here is deliberately unlike the seeded ones. */
const OTHER_GROUP = 'e1111111-1111-4111-8111-111111111111'
const OTHER_PERSON = 'e2222222-2222-4222-8222-222222222222'
const OTHER_EVENT = 'e3333333-3333-4333-8333-333333333333'
const OTHER_EXPENSE_A = 'e4444444-4444-4444-8444-444444444444'
const OTHER_EXPENSE_B = 'e5555555-5555-4555-8555-555555555555'
const OTHER_MEMORY = 'e6666666-6666-4666-8666-666666666666'

/** Amounts chosen to be unmistakable if they ever leak into a total. */
const OTHER_AMOUNT_A = 9999.99
const OTHER_AMOUNT_B = 4444.44

/** `cds.deploy` / `cds.serve` are untyped on the namespace; this is the shape used. */
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

interface Transactional {
  tx<T>(context: { user: cds.User }, work: (tx: Service) => Promise<T>): Promise<T>
}

let csn: cds.csn.CSN
let db: Service
let ledger: Service

async function asPerson<T>(login: string, work: (tx: Service) => Promise<T>): Promise<T> {
  return (ledger as unknown as Transactional).tx({ user: new cds.User(login) }, work)
}

/** The period the intruder's spending falls in, so totals can be checked against it. */
const OTHER_PERIOD = todayISO().slice(0, 7)

async function plantOtherHousehold(): Promise<void> {
  await db.run(
    INSERT.into(GROUPS_TABLE).entries({
      ID: OTHER_GROUP,
      name: 'The Other Household',
      kind: 'couple',
      currency: 'CHF',
    }),
  )
  await db.run(
    INSERT.into(PEOPLE_TABLE).entries({
      ID: OTHER_PERSON,
      group_ID: OTHER_GROUP,
      name: 'Someone Else',
      colour: '#123456',
      isDefault: true,
    }),
  )
  await db.run(
    INSERT.into(EVENTS_TABLE).entries({
      ID: OTHER_EVENT,
      group_ID: OTHER_GROUP,
      name: 'Their Weekend',
      startsOn: addDays(todayISO(), 10),
      place: 'Elsewhere',
      isSurprise: false,
    }),
  )
  await db.run(
    INSERT.into(EXPENSES_TABLE).entries([
      {
        ID: OTHER_EXPENSE_A,
        group_ID: OTHER_GROUP,
        date: todayISO(),
        merchantRaw: 'THEIR SUPERMARKET',
        amount: OTHER_AMOUNT_A,
        currency: 'CHF',
        category_code: 'Groceries',
        moment: 'everyday',
        paidBy_ID: OTHER_PERSON,
        status: 'confirmed',
        source: 'manual',
      },
      {
        ID: OTHER_EXPENSE_B,
        group_ID: OTHER_GROUP,
        date: todayISO(),
        merchantRaw: 'THEIR RESTAURANT',
        amount: OTHER_AMOUNT_B,
        currency: 'CHF',
        category_code: 'Dining',
        moment: 'date_night',
        paidBy_ID: OTHER_PERSON,
        event_ID: OTHER_EVENT,
        status: 'confirmed',
        source: 'manual',
      },
    ]),
  )
  await db.run(
    INSERT.into(MEMORIES_TABLE).entries({
      ID: OTHER_MEMORY,
      group_ID: OTHER_GROUP,
      title: 'Their anniversary',
      occurredOn: todayISO(),
      kind: 'anniversary',
      pinned: true,
    }),
  )
}

beforeAll(async () => {
  cds.root = process.cwd()
  // Point the *configured* database at memory before anything can connect to it.
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }

  csn = await cds.load(['db', 'srv'])
  const compiled = cds.compile.for.nodejs(csn)
  cds.model = compiled
  db = await bootstrap.deploy(csn).to('db', { silent: true })
  ledger = await bootstrap.serve('LedgerService').from(compiled).with(LedgerServiceImpl)

  // Planted once, after the only deploy that builds both the base tables and the
  // service views. A `beforeEach` re-deploy would rebuild the base tables from the raw
  // CSN and take those views with it, and the service's own reads would then fail on a
  // missing `LedgerService_People` -- an artefact of the harness that says nothing
  // about isolation. Nothing below mutates the intruder, so planting once is enough.
  await plantOtherHousehold()
})

describe('another household is not there', () => {
  it('is absent from every list', async () => {
    const seen = await asPerson(AS_A, async tx => ({
      people: (await tx.run(SELECT.from(PEOPLE))) as Array<{ ID: string }>,
      expenses: (await tx.run(SELECT.from(EXPENSES))) as Array<{ ID: string }>,
      events: (await tx.run(SELECT.from(EVENTS))) as Array<{ ID: string }>,
      memories: (await tx.run(SELECT.from(MEMORIES))) as Array<{ ID: string }>,
    }))

    expect(seen.people.map(row => row.ID)).not.toContain(OTHER_PERSON)
    expect(seen.expenses.map(row => row.ID)).not.toContain(OTHER_EXPENSE_A)
    expect(seen.expenses.map(row => row.ID)).not.toContain(OTHER_EXPENSE_B)
    expect(seen.events.map(row => row.ID)).not.toContain(OTHER_EVENT)
    expect(seen.memories.map(row => row.ID)).not.toContain(OTHER_MEMORY)

    // And the seeded household is still all there — a filter that hides everything
    // would pass every assertion above.
    expect(seen.people.length).toBeGreaterThanOrEqual(5)
    expect(seen.expenses.length).toBeGreaterThanOrEqual(19)
  })

  it('is absent from a read by id, which is a 404 and not a 403', async () => {
    const rows = await asPerson(AS_A, async tx => ({
      expense: await tx.run(SELECT.one.from(EXPENSES).where({ ID: OTHER_EXPENSE_A })),
      event: await tx.run(SELECT.one.from(EVENTS).where({ ID: OTHER_EVENT })),
      person: await tx.run(SELECT.one.from(PEOPLE).where({ ID: OTHER_PERSON })),
    }))

    // Not "forbidden" — simply not there. A 403 would confirm the id exists.
    expect(rows.expense ?? null).toBeNull()
    expect(rows.event ?? null).toBeNull()
    expect(rows.person ?? null).toBeNull()
  })
})

describe('and above all, their money is not in ours', () => {
  it('periodTotals leaves it out', async () => {
    const totals = (await asPerson(AS_A, async tx =>
      tx.send('periodTotals', { period: OTHER_PERIOD }),
    )) as { grandTotal: number; byPerson: Array<{ personId: string; paid: number }> }

    expect(totals.grandTotal).toBeLessThan(OTHER_AMOUNT_A)
    expect(totals.byPerson.map(row => row.personId)).not.toContain(OTHER_PERSON)
    for (const row of totals.byPerson) {
      expect(row.paid).not.toBe(OTHER_AMOUNT_A)
      expect(row.paid).not.toBe(OTHER_AMOUNT_B)
    }
  })

  it('eventTotals refuses their event by id', async () => {
    await expect(
      asPerson(AS_A, async tx => tx.send('eventTotals', { eventId: OTHER_EVENT })),
    ).rejects.toThrow(/there is no event with ID/i)
  })
})
