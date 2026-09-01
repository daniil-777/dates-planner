/// <reference types="@cap-js/cds-types" />
/**
 * Event photos, reminders and surprises — CONTRACTS.md §11.
 *
 * ## How this bootstraps
 *
 * Identically to `test/ledger-service.test.ts`: model loaded, deployed to a
 * throwaway in-memory SQLite (seed CSVs included), service constructed with our
 * own implementation class. No HTTP, no `db.sqlite`, nothing shared with the
 * developer's dev database.
 *
 * ## What this file is really about
 *
 * §11.3 has two halves and they pull in opposite directions:
 *
 * 1. A hidden surprise is **absent** from `Events`, `eventTotals`, `upcoming`
 *    and the statement, for everybody except the person who created it.
 * 2. Its **expenses still count**, everywhere, exactly as ordinary spending.
 *
 * The second half is the one worth writing tests for. Hiding an event is easy;
 * the plausible-looking implementation of it hides the event *and* its postings,
 * and then the month total quietly drops by the price of the surprise. That hole
 * gives the surprise away far more loudly than an event chip ever would, and no
 * test that only checks half of the rule would notice. So every "cannot see it"
 * assertion below is paired with a "and the money is still there" one.
 *
 * ## Dates
 *
 * A surprise stops being hidden once its `startsOn` arrives, so the seeded one
 * is dated in the future — and a test about it is therefore a test about today.
 * The two assertions that depend on that are written out as explicit
 * expectations (`seeded.startsOn > todayISO()`), so if the seed is ever left
 * behind by the calendar the failure names the seed rather than the filter.
 * Everything else builds its own events relative to `todayISO()` and does not
 * care what day it is run.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import LedgerServiceImpl from '../srv/ledger-service'
import { addDays, todayISO } from '../srv/lib/dates'
import { MAX_UPLOAD_BYTES } from '../srv/lib/images'
import { round2 } from '../srv/lib/money'

for (const key of ['ANTHROPIC_API_KEY', 'LLM_BASE_URL', 'LLM_API_KEY', 'AICORE_SERVICE_KEY']) {
  delete process.env[key]
}

const { DELETE, INSERT, SELECT, UPDATE } = cds.ql

const EXPENSES = 'LedgerService.Expenses'
const PEOPLE = 'LedgerService.People'
const EVENTS = 'LedgerService.Events'
const EVENT_PARTICIPANTS = 'LedgerService.EventParticipants'
const EVENT_PHOTOS = 'LedgerService.EventPhotos'
const REMINDERS = 'LedgerService.Reminders'

const PARTNER_A = 'a0000000-0000-4000-8000-000000000001'
const PARTNER_B = 'b0000000-0000-4000-8000-000000000002'

/** Four people, three postings, one long weekend. In the past. */
const LISBON = 'f0000000-0000-4000-8000-000000000001'
/** Three people, one posting, one evening. Also in the past. */
const DINNER = 'f0000000-0000-4000-8000-000000000002'
/** The seeded future event: what makes "current/upcoming" non-empty on day one. */
const ENGADIN = 'f0000000-0000-4000-8000-000000000003'
/** The seeded surprise. Planned by Partner A, invisible to everybody else. */
const VALS = 'f0000000-0000-4000-8000-000000000004'
/** The one seeded reminder, on the Engadin trip. */
const SLEEPER = 'r0000000-0000-4000-8000-000000000001'

/** CAP's mocked user arrives as a login name; these two happen to match `People.name`. */
const AS_A = 'Partner A'
const AS_B = 'Partner B'
/** Nobody in the ledger is called this. The fallback has to cope. */
const AS_STRANGER = 'someone-else@identity-provider'

interface EventRow {
  ID?: string
  name?: string | null
  startsOn?: string | null
  endsOn?: string | null
  place?: string | null
  isSurprise?: boolean | null
  createdBy_ID?: string | null
  revealedAt?: string | null
}

interface ReminderRow {
  ID?: string
  event_ID?: string | null
  leadDays?: number | null
  note?: string | null
  done?: boolean | null
}

interface PhotoRow {
  ID?: string
  event_ID?: string | null
  mediaType?: string | null
  caption?: string | null
  takenOn?: string | null
  image?: Buffer | Uint8Array | null
}

interface ExpenseRow {
  ID?: string
  amount?: number | string | null
  event_ID?: string | null
  category_code?: string | null
}

interface ParticipantRow {
  event_ID?: string | null
  person_ID?: string | null
}

interface CalendarRow {
  ID: string
  kind: 'event' | 'reminder'
  date: string
  endsOn: string | null
  title: string
  place: string | null
  eventId: string
  onlyYou: boolean
  leadDays: number | null
  done: boolean | null
}

interface PeriodTotalsRow {
  period: string
  grandTotal: number
  count: number
  byPerson: Array<{ personId: string; name: string; paid: number; count: number; share: number }>
}

interface EventTotalsRow {
  eventId: string
  name: string
  grandTotal: number
  perHead: number
  participantCount: number
  count: number
}

interface MonthlyTotalRow {
  period: string
  category: string
  total: number
}

interface StatementRow {
  contentMarkdown?: string | null
}

/**
 * `cds.deploy(...)` and `cds.serve(...).with(<class>)` are real API that
 * `@cap-js/cds-types` does not declare; `srv.tx({user}, …)` is the same story.
 * Typed here with exactly the shape this file uses, and nothing more, rather
 * than reaching for `any`.
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

interface Transactional {
  tx<T>(context: { user: unknown }, work: (tx: Service) => Promise<T>): Promise<T>
}

const bootstrap = cds as unknown as CdsBootstrap

let ledger: Service
let db: Service
let csn: cds.csn.CSN

/** `Decimal(10,2)` comes back as a number or a string depending on the driver. */
function money(value: number | string | null | undefined): number {
  return round2(Number(value ?? 0))
}

/**
 * Runs some work as a named person, exactly as CAP's mocked user would arrive.
 *
 * The login name is a *name*, not a `People.ID`: mapping one to the other is the
 * thing under test (CONTRACTS §11.3, last paragraph).
 *
 * The **callback** form of `srv.tx` matters here, and the reason is worth a
 * sentence. `const tx = srv.tx(ctx)` hands back a transaction but leaves
 * `cds.context` unset outside of it, so anything that reaches for the ambient
 * database — `aggregateYear`, which fires its five reads with `Promise.all` —
 * opens a connection per query. Against `:memory:` a second connection is a
 * second, *empty* database, and the statement comes back complaining that
 * `twowaymatch_Memories` does not exist. `srv.tx(ctx, fn)` runs `fn` inside the
 * transaction's async scope, so every one of those reads finds the same context
 * and the same connection. It also commits on success and rolls back on a throw,
 * which is what the `.rejects` assertions below want.
 */
async function asPerson<T>(login: string, work: (tx: Service) => Promise<T>): Promise<T> {
  return (ledger as unknown as Transactional).tx({ user: new cds.User(login) }, work)
}

/** Every event this person is allowed to know about, by name. */
async function eventNamesSeenBy(login: string): Promise<string[]> {
  const rows = await asPerson(login, async tx => tx.run(SELECT.from(EVENTS)) as Promise<EventRow[]>)
  return rows.map(row => row.name ?? '')
}

async function upcomingFor(
  login: string,
  fromDate: string,
  toDate: string,
): Promise<CalendarRow[]> {
  return (await asPerson(login, async tx =>
    tx.send('upcoming', { fromDate, toDate }),
  )) as CalendarRow[]
}

async function periodTotalsFor(login: string, period: string): Promise<PeriodTotalsRow> {
  return (await asPerson(login, async tx => tx.send('periodTotals', { period }))) as PeriodTotalsRow
}

/** Reads a row straight from the database, bypassing every service handler. */
async function readEvent(ID: string): Promise<EventRow> {
  return (await db.run(SELECT.one.from(EVENTS).where({ ID }))) as EventRow
}

/**
 * The bytes of a stored `@Core.MediaType` column.
 *
 * cds-sqlite hands a media column back as a `Readable` rather than a `Buffer`,
 * which is the right call for a 4 MB JPEG on a real server and an inconvenience
 * in a test that wants to look inside one.
 */
async function bytesOf(value: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  const chunks: Buffer[] = []
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/** A small, real photo. EXIF is added by the caller when the test is about EXIF. */
async function makePhoto(width = 800, height = 1200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 244, g: 240, b: 232 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/** Creates a confirmed posting through the service, so every `before` handler runs. */
async function post(row: Record<string, unknown>): Promise<ExpenseRow> {
  const ID = cds.utils.uuid()
  await ledger.run(INSERT.into(EXPENSES).entries({ ID, status: 'confirmed', ...row }))
  return (await db.run(SELECT.one.from(EXPENSES).where({ ID }))) as ExpenseRow
}

/** A surprise of our own, so a test does not depend on what day it is run. */
async function planSurprise(
  options: {
    name?: string
    daysAway?: number
    createdBy?: string | null
    revealedAt?: string | null
  } = {},
): Promise<string> {
  const ID = cds.utils.uuid()
  await db.run(
    INSERT.into(EVENTS).entries({
      ID,
      name: options.name ?? 'Something on a Thursday',
      startsOn: addDays(todayISO(), options.daysAway ?? 30),
      place: 'Undisclosed',
      isSurprise: true,
      createdBy_ID: 'createdBy' in options ? options.createdBy : PARTNER_A,
      revealedAt: options.revealedAt ?? null,
    }),
  )
  return ID
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
})

beforeEach(async () => {
  await bootstrap.deploy(csn).to(db, { silent: true })
})

/* ------------------------------------------------------------------ *
 *  The seed
 * ------------------------------------------------------------------ */

describe('the seed', () => {
  it('dates one event in the future, so nothing upcoming is ever empty', async () => {
    const engadin = await readEvent(ENGADIN)

    // If this ever fails, the calendar has caught up with the seed: move the
    // Engadin dates forward in db/data/twowaymatch-Events.csv. The filter is fine.
    expect(String(engadin.startsOn) > todayISO()).toBe(true)
    expect(engadin.isSurprise).toBe(false)
  })

  it('plans one surprise, so the hidden path has coverage from the first run', async () => {
    const vals = await readEvent(VALS)

    expect(vals.isSurprise).toBe(true)
    expect(vals.createdBy_ID).toBe(PARTNER_A)
    expect(vals.revealedAt).toBeNull()
    // Same tripwire as above: a surprise in the past is not a surprise any more.
    expect(String(vals.startsOn) > todayISO()).toBe(true)
  })

  it('hangs one reminder off a future event', async () => {
    const reminders = (await db.run(SELECT.from(REMINDERS))) as ReminderRow[]

    expect(reminders).toHaveLength(1)
    expect(reminders[0].ID).toBe(SLEEPER)
    expect(reminders[0].event_ID).toBe(ENGADIN)
    expect(reminders[0].leadDays).toBe(14)
    expect(reminders[0].done).toBe(false)
  })

  it('starts with no photographs, because a CSV cannot carry a JPEG', async () => {
    expect(await db.run(SELECT.from(EVENT_PHOTOS))).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 *  §11.3 rule 1 — the event disappears
 * ------------------------------------------------------------------ */

describe('a hidden surprise is not there', () => {
  it('is missing from the event list for everybody but its creator', async () => {
    expect(await eventNamesSeenBy(AS_B)).not.toContain('Weekend in Vals')
    expect(await eventNamesSeenBy(AS_A)).toContain('Weekend in Vals')
  })

  it('is missing when it is asked for by key, too', async () => {
    const seenByB = await asPerson(AS_B, async tx =>
      tx.run(SELECT.one.from(EVENTS).where({ ID: VALS })),
    )
    const seenByA = await asPerson(AS_A, async tx =>
      tx.run(SELECT.one.from(EVENTS).where({ ID: VALS })),
    )

    expect(seenByB).toBeUndefined()
    expect((seenByA as EventRow).name).toBe('Weekend in Vals')
  })

  it('narrows a filtered read instead of replacing the filter', async () => {
    // Two assertions in one: the surprise is filtered out of a `$filter`ed read,
    // and the caller's own filter still applies to everything else. A `.where()`
    // that clobbered the existing one would pass the first and fail the second.
    const inVals = await asPerson(
      AS_B,
      async tx => tx.run(SELECT.from(EVENTS).where({ place: 'Vals' })) as Promise<EventRow[]>,
    )
    const inZurich = await asPerson(
      AS_B,
      async tx => tx.run(SELECT.from(EVENTS).where({ place: 'Zürich' })) as Promise<EventRow[]>,
    )

    expect(inVals).toEqual([])
    expect(inZurich.map(row => row.name)).toEqual(['Kronenhalle Dinner'])
  })

  it('takes its guest list with it', async () => {
    const seenByB = (await asPerson(
      AS_B,
      async tx => tx.run(SELECT.from(EVENT_PARTICIPANTS)) as Promise<ParticipantRow[]>,
    )) as ParticipantRow[]
    const seenByA = (await asPerson(
      AS_A,
      async tx => tx.run(SELECT.from(EVENT_PARTICIPANTS)) as Promise<ParticipantRow[]>,
    )) as ParticipantRow[]

    // Partner B is *on* the Vals weekend. Seeing the membership row would tell
    // them exactly as much as seeing the event.
    expect(seenByB.filter(row => row.event_ID === VALS)).toEqual([])
    expect(seenByA.filter(row => row.event_ID === VALS)).toHaveLength(2)
  })

  it('takes its reminders with it', async () => {
    await asPerson(AS_A, async tx =>
      tx.send('createReminder', { eventId: VALS, leadDays: 3, note: 'Pack the good towel.' }),
    )

    const seenByB = (await asPerson(
      AS_B,
      async tx => tx.run(SELECT.from(REMINDERS)) as Promise<ReminderRow[]>,
    )) as ReminderRow[]
    const seenByA = (await asPerson(
      AS_A,
      async tx => tx.run(SELECT.from(REMINDERS)) as Promise<ReminderRow[]>,
    )) as ReminderRow[]

    expect(seenByB.map(row => row.event_ID)).toEqual([ENGADIN])
    expect(seenByA.map(row => row.event_ID).sort()).toEqual([ENGADIN, VALS].sort())
  })

  it('takes its photographs with it', async () => {
    await asPerson(AS_A, async tx =>
      tx.send('addEventPhoto', {
        eventId: VALS,
        image: await makePhoto(400, 300),
        mediaType: 'image/jpeg',
        caption: 'The brochure.',
      }),
    )

    expect(await asPerson(AS_B, async tx => tx.run(SELECT.from(EVENT_PHOTOS)))).toEqual([])
    expect(await asPerson(AS_A, async tx => tx.run(SELECT.from(EVENT_PHOTOS)))).toHaveLength(1)
  })

  it('answers eventTotals with the same 404 as an id that names nothing', async () => {
    // Not a 403: "that exists but is not for you" is itself the secret.
    await expect(
      asPerson(AS_B, async tx => tx.send('eventTotals', { eventId: VALS })),
    ).rejects.toThrow(/there is no event with ID/i)

    const forA = (await asPerson(AS_A, async tx =>
      tx.send('eventTotals', { eventId: VALS }),
    )) as EventTotalsRow
    expect(forA.name).toBe('Weekend in Vals')
    expect(forA.participantCount).toBe(2)
  })

  it('is missing from the calendar, reminder and all', async () => {
    await asPerson(AS_A, async tx => tx.send('createReminder', { eventId: VALS, leadDays: 5 }))

    const window = { from: addDays(todayISO(), -1), to: addDays(todayISO(), 120) }
    const forB = await upcomingFor(AS_B, window.from, window.to)
    const forA = await upcomingFor(AS_A, window.from, window.to)

    expect(forB.filter(entry => entry.eventId === VALS)).toEqual([])
    expect(forA.filter(entry => entry.eventId === VALS)).toHaveLength(2)
    expect(forA.filter(entry => entry.eventId === VALS).every(entry => entry.onlyYou)).toBe(true)
  })

  it('is missing from the yearly statement, which still totals the same money', async () => {
    await post({
      date: addDays(todayISO(), -3),
      merchantRaw: 'THERME VALS',
      amount: 540,
      currency: 'CHF',
      category_code: 'Travel',
      moment: 'trip',
      paidBy_ID: PARTNER_A,
      event_ID: VALS,
    })
    const year = Number(todayISO().slice(0, 4))

    const forB = (await asPerson(AS_B, async tx =>
      tx.send('generateStatement', { year }),
    )) as StatementRow
    const forA = (await asPerson(AS_A, async tx =>
      tx.send('generateStatement', { year }),
    )) as StatementRow

    expect(String(forB.contentMarkdown)).not.toContain('Weekend in Vals')
    expect(String(forA.contentMarkdown)).toContain('Weekend in Vals')

    // …and the year came to the same money in both, because rule 2 says the
    // spending is never hidden — only the name of the occasion is.
    const yearTotal = (markdown: string): string => {
      const match = /\*\*(CHF [\d'.]+)\*\*/.exec(markdown)
      if (match === null) throw new Error('the statement printed no total at all')
      return match[1]
    }
    expect(yearTotal(String(forB.contentMarkdown))).toBe(yearTotal(String(forA.contentMarkdown)))
  })
})

/* ------------------------------------------------------------------ *
 *  §11.3 rule 2 — the money is still there. THE test.
 * ------------------------------------------------------------------ */

describe('a hidden surprise still costs what it costs', () => {
  const PERIOD = todayISO().slice(0, 7)

  async function bookTheSurprise(): Promise<void> {
    await post({
      date: todayISO(),
      merchantRaw: 'THERME VALS RESERVIERUNG',
      amount: 340,
      currency: 'CHF',
      category_code: 'Travel',
      moment: 'trip',
      paidBy_ID: PARTNER_A,
      event_ID: VALS,
    })
  }

  it('counts toward the month for the person it is hidden from', async () => {
    const before = await periodTotalsFor(AS_B, PERIOD)
    await bookTheSurprise()
    const after = await periodTotalsFor(AS_B, PERIOD)

    // This is the assertion the whole feature turns on. A naive filter that
    // hides the event by hiding its expenses passes every test above and fails
    // this one — and in the app it would punch a 340-franc hole in the month,
    // which is a louder announcement than the event chip ever was.
    expect(money(after.grandTotal)).toBe(money(before.grandTotal) + 340)
    expect(after.count).toBe(before.count + 1)
  })

  it('gives the two of them exactly the same month', async () => {
    await bookTheSurprise()

    const forA = await periodTotalsFor(AS_A, PERIOD)
    const forB = await periodTotalsFor(AS_B, PERIOD)

    expect(money(forB.grandTotal)).toBe(money(forA.grandTotal))
    expect(forB.count).toBe(forA.count)
    expect(forB.byPerson.map(row => [row.personId, money(row.paid), row.count])).toEqual(
      forA.byPerson.map(row => [row.personId, money(row.paid), row.count]),
    )
  })

  it('is in monthlyTotals under its own category', async () => {
    await bookTheSurprise()

    const rows = (await asPerson(AS_B, async tx =>
      tx.send('monthlyTotals', { fromPeriod: PERIOD, toPeriod: PERIOD }),
    )) as MonthlyTotalRow[]
    const travel = rows.find(row => row.category === 'Travel')

    expect(travel).toBeDefined()
    expect(money(travel?.total)).toBe(340)
  })

  it('is in the ledger, event id and all, for the person it is hidden from', async () => {
    await bookTheSurprise()

    const rows = (await asPerson(
      AS_B,
      async tx => tx.run(SELECT.from(EXPENSES).where({ event_ID: VALS })) as Promise<ExpenseRow[]>,
    )) as ExpenseRow[]

    expect(rows).toHaveLength(1)
    expect(money(rows[0].amount)).toBe(340)
    // The posting keeps its `event_ID`. What Partner B cannot do is look the
    // event up — which is what makes it a chip with no label rather than a lie.
    expect(rows[0].event_ID).toBe(VALS)
    expect(
      await asPerson(AS_B, async tx => tx.run(SELECT.one.from(EVENTS).where({ ID: VALS }))),
    ).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 *  When a surprise stops being one
 * ------------------------------------------------------------------ */

describe('a surprise stops being one', () => {
  it('when its creator reveals it', async () => {
    expect(await eventNamesSeenBy(AS_B)).not.toContain('Weekend in Vals')

    const revealed = (await asPerson(AS_A, async tx =>
      tx.send('revealSurprise', { ID: VALS }),
    )) as EventRow
    expect(revealed.revealedAt).toBeTruthy()

    expect(await eventNamesSeenBy(AS_B)).toContain('Weekend in Vals')
    const totals = (await asPerson(AS_B, async tx =>
      tx.send('eventTotals', { eventId: VALS }),
    )) as EventTotalsRow
    expect(totals.name).toBe('Weekend in Vals')
  })

  it('when its first day arrives, with nobody having said anything', async () => {
    const ID = await planSurprise({ name: 'Yesterday, apparently', daysAway: -1 })

    expect(await eventNamesSeenBy(AS_B)).toContain('Yesterday, apparently')
    expect(String((await readEvent(ID)).revealedAt ?? '')).toBe('')
  })

  it('but not one minute before, and not on somebody else’s say-so', async () => {
    await expect(
      asPerson(AS_B, async tx => tx.send('revealSurprise', { ID: VALS })),
    ).rejects.toThrow(/there is no event with ID/i)

    expect(await eventNamesSeenBy(AS_B)).not.toContain('Weekend in Vals')
  })

  it('refuses to reveal an ordinary event', async () => {
    await expect(
      asPerson(AS_A, async tx => tx.send('revealSurprise', { ID: DINNER })),
    ).rejects.toThrow(/is not a surprise/i)
  })

  it('refuses to reveal the same surprise twice', async () => {
    await asPerson(AS_A, async tx => tx.send('revealSurprise', { ID: VALS }))

    await expect(
      asPerson(AS_A, async tx => tx.send('revealSurprise', { ID: VALS })),
    ).rejects.toThrow(/has already been revealed/i)
  })

  it('is hidden from everybody when nobody planned it', async () => {
    // Fails closed: an event that says it is a secret and names no owner is a
    // secret from all of us. Showing it to the wrong person cannot be undone.
    const ID = await planSurprise({ name: 'Ownerless', createdBy: null })

    expect(await eventNamesSeenBy(AS_A)).not.toContain('Ownerless')
    expect(await eventNamesSeenBy(AS_B)).not.toContain('Ownerless')
    expect((await readEvent(ID)).name).toBe('Ownerless')
  })
})

/* ------------------------------------------------------------------ *
 *  Identity (CONTRACTS §11.3, last paragraph)
 * ------------------------------------------------------------------ */

describe('who is asking', () => {
  it('maps a mocked login name onto the person who has it', async () => {
    expect(await eventNamesSeenBy(AS_A)).toContain('Weekend in Vals')
    expect(await eventNamesSeenBy(AS_B)).not.toContain('Weekend in Vals')
  })

  it('maps an email address, for a deployment whose identity provider sends one', async () => {
    expect(await eventNamesSeenBy('partner-b@example.com')).not.toContain('Weekend in Vals')
    expect(await eventNamesSeenBy('partner-a@example.com')).toContain('Weekend in Vals')
  })

  it('falls back to the first household member when the mapping misses', async () => {
    // Partner A is the first `isDefault` person by name, so an unrecognised user
    // gets their view — and, crucially, does not get an exception.
    const names = await eventNamesSeenBy(AS_STRANGER)

    expect(names).toContain('Weekend in Vals')
    expect(names).toContain('Lisbon Weekend')
  })

  it('does not break when the ledger has nobody in it at all', async () => {
    await db.run(DELETE.from(EXPENSES))
    await db.run(DELETE.from(EVENT_PARTICIPANTS))
    await db.run(DELETE.from(PEOPLE))

    // No roster, no identity, so every unrevealed surprise stays shut — but the
    // list still answers, which is the part that must never throw.
    const names = await eventNamesSeenBy(AS_A)
    expect(names).toContain('Lisbon Weekend')
    expect(names).not.toContain('Weekend in Vals')
  })

  it('credits a new event to whoever created it', async () => {
    const ID = cds.utils.uuid()
    await asPerson(AS_B, async tx =>
      tx.run(
        INSERT.into(EVENTS).entries({
          ID,
          name: 'B plans something',
          startsOn: addDays(todayISO(), 40),
        }),
      ),
    )

    expect((await readEvent(ID)).createdBy_ID).toBe(PARTNER_B)
  })

  it('lets a caller name the creator, as long as that person exists', async () => {
    const ID = cds.utils.uuid()
    await asPerson(AS_B, async tx =>
      tx.run(
        INSERT.into(EVENTS).entries({
          ID,
          name: 'Booked by B, planned by A',
          startsOn: addDays(todayISO(), 40),
          createdBy_ID: PARTNER_A,
        }),
      ),
    )
    expect((await readEvent(ID)).createdBy_ID).toBe(PARTNER_A)

    await expect(
      ledger.run(
        INSERT.into(EVENTS).entries({
          ID: cds.utils.uuid(),
          name: 'Planned by nobody',
          startsOn: addDays(todayISO(), 40),
          createdBy_ID: '00000000-0000-4000-8000-00000000beef',
        }),
      ),
    ).rejects.toThrow(/there is nobody in the ledger with ID/)
  })
})

/* ------------------------------------------------------------------ *
 *  Reminders (§11.2)
 * ------------------------------------------------------------------ */

describe('createReminder()', () => {
  it('hangs a nudge off an event', async () => {
    const reminder = (await asPerson(AS_B, async tx =>
      tx.send('createReminder', { eventId: ENGADIN, leadDays: 3, note: 'Wax the skis.' }),
    )) as ReminderRow

    expect(reminder.event_ID).toBe(ENGADIN)
    expect(reminder.leadDays).toBe(3)
    expect(reminder.note).toBe('Wax the skis.')
    expect(reminder.done).toBe(false)
  })

  it('defaults to the day before, as CONTRACTS §11.2 says', async () => {
    const reminder = (await asPerson(AS_B, async tx =>
      tx.send('createReminder', { eventId: ENGADIN }),
    )) as ReminderRow

    expect(reminder.leadDays).toBe(1)
    expect(reminder.note).toBeNull()
  })

  it('takes a lead time of zero — the nudge on the day itself', async () => {
    const reminder = (await asPerson(AS_B, async tx =>
      tx.send('createReminder', { eventId: ENGADIN, leadDays: 0 }),
    )) as ReminderRow

    expect(reminder.leadDays).toBe(0)
  })

  it('refuses a lead time that would fire after the event, or a decade before it', async () => {
    for (const leadDays of [-1, 366, 2.5]) {
      await expect(
        asPerson(AS_B, async tx => tx.send('createReminder', { eventId: ENGADIN, leadDays })),
      ).rejects.toThrow(/leadDays must be a whole number of days between 0 and 365/)
    }
  })

  it('refuses a note longer than the column that has to hold it', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('createReminder', { eventId: ENGADIN, note: 'x'.repeat(201) }),
      ),
    ).rejects.toThrow(/at most 200 characters; this one is 201/)
  })

  it('refuses an event that is not in the ledger', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('createReminder', { eventId: '00000000-0000-4000-8000-00000000dead' }),
      ),
    ).rejects.toThrow(/there is no event with ID/i)

    await expect(asPerson(AS_B, async tx => tx.send('createReminder', {}))).rejects.toThrow(
      /needs the ID of the event/i,
    )
  })

  it('refuses an event the caller is not allowed to know exists', async () => {
    await expect(
      asPerson(AS_B, async tx => tx.send('createReminder', { eventId: VALS })),
    ).rejects.toThrow(/there is no event with ID/i)
  })
})

describe('completeReminder()', () => {
  it('ticks a reminder off, twice if the phone was slow', async () => {
    const first = (await asPerson(AS_B, async tx =>
      tx.send('completeReminder', { ID: SLEEPER }),
    )) as ReminderRow
    expect(first.done).toBe(true)

    // Idempotent on purpose, unlike markSettled: writing `true` over `true`
    // costs nothing, and a double tap is not worth a red banner.
    const second = (await asPerson(AS_B, async tx =>
      tx.send('completeReminder', { ID: SLEEPER }),
    )) as ReminderRow
    expect(second.done).toBe(true)
  })

  it('refuses a reminder that is not there', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('completeReminder', { ID: '00000000-0000-4000-8000-00000000dead' }),
      ),
    ).rejects.toThrow(/there is no reminder with ID/i)
  })

  it('refuses a reminder on a surprise the caller cannot see', async () => {
    const hidden = (await asPerson(AS_A, async tx =>
      tx.send('createReminder', { eventId: VALS, leadDays: 2 }),
    )) as ReminderRow

    await expect(
      asPerson(AS_B, async tx => tx.send('completeReminder', { ID: hidden.ID })),
    ).rejects.toThrow(/there is no event with ID/i)
  })
})

/* ------------------------------------------------------------------ *
 *  upcoming() — the calendar, in one call
 * ------------------------------------------------------------------ */

describe('upcoming()', () => {
  it('answers events and reminders together, in calendar order', async () => {
    const entries = await upcomingFor(AS_B, '2026-12-01', '2026-12-31')

    // The Engadin trip starts on the 27th; its reminder falls 14 days earlier.
    expect(entries.map(entry => [entry.date, entry.kind, entry.eventId])).toEqual([
      ['2026-12-13', 'reminder', ENGADIN],
      ['2026-12-27', 'event', ENGADIN],
    ])

    const [reminder, event] = entries
    expect(reminder.ID).toBe(SLEEPER)
    expect(reminder.leadDays).toBe(14)
    expect(reminder.done).toBe(false)
    expect(reminder.title).toMatch(/Book the sleeper/)
    expect(event.ID).toBe(ENGADIN)
    expect(event.title).toBe('Engadin Between the Years')
    expect(event.endsOn).toBe('2026-12-30')
    expect(event.place).toBe('Pontresina')
    expect(event.onlyYou).toBe(false)
  })

  it('puts the event before the nudge when both land on the same day', async () => {
    await asPerson(AS_B, async tx => tx.send('createReminder', { eventId: ENGADIN, leadDays: 0 }))

    const sameDay = (await upcomingFor(AS_B, '2026-12-27', '2026-12-27')).map(entry => entry.kind)
    expect(sameDay).toEqual(['event', 'reminder'])
  })

  it('keeps a trip that started before the window but is still going', async () => {
    // The Lisbon weekend runs 10–13 April; a window that opens on the 12th is
    // still inside it, and a grid that dropped it would show an empty Sunday in
    // the middle of a holiday.
    const entries = await upcomingFor(AS_B, '2026-04-12', '2026-04-30')

    expect(entries.map(entry => entry.eventId)).toEqual([LISBON])
    expect(entries[0].date).toBe('2026-04-10')
    expect(entries[0].endsOn).toBe('2026-04-13')
  })

  it('leaves out a trip that ended before the window opened', async () => {
    expect(await upcomingFor(AS_B, '2026-04-14', '2026-04-30')).toEqual([])
  })

  it('reports a one-day event with no end date', async () => {
    const entries = await upcomingFor(AS_B, '2026-06-01', '2026-06-30')

    expect(entries.map(entry => entry.eventId)).toEqual([DINNER])
    expect(entries[0].endsOn).toBeNull()
    expect(entries[0].leadDays).toBeNull()
    expect(entries[0].done).toBeNull()
  })

  it('marks the creator’s own secret, and shows it to nobody else', async () => {
    const window = { from: addDays(todayISO(), -1), to: addDays(todayISO(), 400) }
    const forA = await upcomingFor(AS_A, window.from, window.to)
    const forB = await upcomingFor(AS_B, window.from, window.to)

    const secret = forA.find(entry => entry.eventId === VALS)
    expect(secret?.onlyYou).toBe(true)
    expect(secret?.title).toBe('Weekend in Vals')
    expect(forA.filter(entry => entry.onlyYou === false).length).toBeGreaterThan(0)
    expect(forB.some(entry => entry.onlyYou)).toBe(false)
  })

  it('refuses a window it cannot read', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('upcoming', { fromDate: 'next tuesday', toDate: '2026-12-31' }),
      ),
    ).rejects.toThrow(/fromDate must be a date of the form YYYY-MM-DD/)

    await expect(
      asPerson(AS_B, async tx =>
        tx.send('upcoming', { fromDate: '2026-12-31', toDate: '2026-12-01' }),
      ),
    ).rejects.toThrow(/is after toDate/)
  })
})

/* ------------------------------------------------------------------ *
 *  Photos (§11.1)
 * ------------------------------------------------------------------ */

describe('addEventPhoto()', () => {
  it('stores a picture against an event, stripped and re-encoded', async () => {
    const photo = (await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: LISBON,
        image: await makePhoto(),
        mediaType: 'image/jpeg',
        caption: 'Six of them. No regrets.',
        takenOn: '2026-04-13',
      }),
    )) as PhotoRow

    expect(photo.event_ID).toBe(LISBON)
    expect(photo.mediaType).toBe('image/jpeg')
    expect(photo.caption).toBe('Six of them. No regrets.')
    expect(String(photo.takenOn).slice(0, 10)).toBe('2026-04-13')
    // The action answers with the metadata, never with the megabytes.
    expect(photo.image).toBeUndefined()
  })

  it('takes the bytes through the same pipeline as a receipt', async () => {
    const CANARY = 'Nikon-Serial-000000'
    const withExif = await sharp({
      create: { width: 3200, height: 2400, channels: 3, background: { r: 20, g: 90, b: 140 } },
    })
      .withExif({
        IFD0: { Make: CANARY },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '46/1 37/1 0/1' },
      })
      .jpeg()
      .toBuffer()
    expect(withExif.includes(Buffer.from(CANARY, 'utf8'))).toBe(true)

    const photo = (await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: LISBON,
        image: withExif,
        mediaType: 'image/jpeg',
      }),
    )) as PhotoRow

    const stored = (await db.run(
      SELECT.one.from(EVENT_PHOTOS).columns('image').where({ ID: photo.ID }),
    )) as PhotoRow
    const bytes = await bytesOf(stored.image)

    // EXIF gone, long edge capped at 2000 (CONTRACTS §11.1 → srv/lib/images.ts).
    expect(bytes.includes(Buffer.from(CANARY, 'utf8'))).toBe(false)
    const metadata = await sharp(bytes).metadata()
    expect(metadata.exif).toBeUndefined()
    expect(metadata.format).toBe('jpeg')
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2000)
  })

  it('accepts the base64 an OData client sends, and a PNG', async () => {
    const png = await sharp({
      create: { width: 320, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer()

    const photo = (await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: LISBON,
        image: png.toString('base64'),
        mediaType: 'image/png',
      }),
    )) as PhotoRow

    expect(photo.mediaType).toBe('image/jpeg')
  })

  it('refuses anything over the 10 MB ceiling, and says what the ceiling is', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', {
          eventId: LISBON,
          image: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x4a),
          mediaType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow(/the limit is 10485760 \(10 MB\)/)
  })

  it('refuses something that is not an image at all', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', {
          eventId: LISBON,
          image: Buffer.from('%PDF-1.7'),
          mediaType: 'application/pdf',
        }),
      ),
    ).rejects.toThrow(/application\/pdf is not an image/)

    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', {
          eventId: LISBON,
          image: Buffer.from('this is not a JPEG at all'),
          mediaType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow(/could not read this image/)
  })

  it('asks for the parameters it needs by name', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', { eventId: LISBON, mediaType: 'image/jpeg' }),
      ),
    ).rejects.toThrow(/needs the photograph in the "image" parameter/)

    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', { eventId: LISBON, image: await makePhoto() }),
      ),
    ).rejects.toThrow(/needs the media type of the photograph/)

    // `takenOn` is declared `Date`, so CAP type-checks it before the handler
    // is reached — including a month that does not exist. The handler does not
    // re-check what the framework already guarantees; `upcoming`'s bounds are
    // declared `String` and *are* checked by hand, further down.
    for (const takenOn of ['sometime in April', '2026-13-01']) {
      await expect(
        asPerson(AS_B, async tx =>
          tx.send('addEventPhoto', {
            eventId: LISBON,
            image: await makePhoto(),
            mediaType: 'image/jpeg',
            takenOn,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ASSERT_DATA_TYPE', target: 'takenOn' })
    }
  })

  it('refuses a caption longer than the column that has to hold it', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', {
          eventId: LISBON,
          image: await makePhoto(),
          mediaType: 'image/jpeg',
          caption: 'y'.repeat(201),
        }),
      ),
    ).rejects.toThrow(/a caption is at most 200 characters; this one is 201/)
  })

  it('refuses an event that is not there, or not visible', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', {
          eventId: '00000000-0000-4000-8000-00000000dead',
          image: await makePhoto(),
          mediaType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow(/there is no event with ID/i)

    await expect(
      asPerson(AS_B, async tx =>
        tx.send('addEventPhoto', {
          eventId: VALS,
          image: await makePhoto(),
          mediaType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow(/there is no event with ID/i)
  })

  it('is the only way a photograph gets in', async () => {
    // A plain POST would walk straight past the EXIF strip and store a phone
    // photo complete with the coordinates of somebody's front door.
    await expect(
      ledger.run(
        INSERT.into(EVENT_PHOTOS).entries({
          ID: cds.utils.uuid(),
          event_ID: LISBON,
          image: await makePhoto(),
          mediaType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow(/uploaded with the addEventPhoto action/)

    const photo = (await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: LISBON,
        image: await makePhoto(),
        mediaType: 'image/jpeg',
      }),
    )) as PhotoRow

    // Re-captioning is not a write of image bytes, and is left alone.
    await ledger.run(
      UPDATE.entity(EVENT_PHOTOS, String(photo.ID)).with({ caption: 'Belém, the queue.' }),
    )
    expect(
      (
        (await db.run(
          SELECT.one.from(EVENT_PHOTOS).columns('caption').where({ ID: photo.ID }),
        )) as PhotoRow
      ).caption,
    ).toBe('Belém, the queue.')

    await expect(
      ledger.run(UPDATE.entity(EVENT_PHOTOS, String(photo.ID)).with({ image: await makePhoto() })),
    ).rejects.toThrow(/uploaded with the addEventPhoto action/)
  })
})

describe('deleteEventPhoto()', () => {
  it('removes the picture and nothing else', async () => {
    const kept = (await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: LISBON,
        image: await makePhoto(),
        mediaType: 'image/jpeg',
        caption: 'Kept.',
      }),
    )) as PhotoRow
    const doomed = (await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: LISBON,
        image: await makePhoto(),
        mediaType: 'image/jpeg',
        caption: 'A thumb, mostly.',
      }),
    )) as PhotoRow

    await asPerson(AS_B, async tx => tx.send('deleteEventPhoto', { ID: doomed.ID }))

    const left = (await db.run(SELECT.from(EVENT_PHOTOS).columns('ID'))) as PhotoRow[]
    expect(left.map(row => row.ID)).toEqual([kept.ID])
    expect(await readEvent(LISBON)).toBeTruthy()
    expect(await db.run(SELECT.from(EXPENSES).where({ event_ID: LISBON }))).toHaveLength(3)
  })

  it('refuses a photograph that is not there', async () => {
    await expect(
      asPerson(AS_B, async tx =>
        tx.send('deleteEventPhoto', { ID: '00000000-0000-4000-8000-00000000dead' }),
      ),
    ).rejects.toThrow(/there is no photograph with ID/i)

    await expect(asPerson(AS_B, async tx => tx.send('deleteEventPhoto', {}))).rejects.toThrow(
      /needs the ID of the photograph/i,
    )
  })
})

/* ------------------------------------------------------------------ *
 *  Deleting an event
 * ------------------------------------------------------------------ */

describe('deleting an event', () => {
  it('takes its photographs and reminders, and still leaves its money alone', async () => {
    await asPerson(AS_B, async tx =>
      tx.send('addEventPhoto', {
        eventId: ENGADIN,
        image: await makePhoto(),
        mediaType: 'image/jpeg',
      }),
    )
    await post({
      date: todayISO(),
      merchantRaw: 'RHB BILLETT',
      amount: 88,
      currency: 'CHF',
      paidBy_ID: PARTNER_B,
      event_ID: ENGADIN,
    })

    await ledger.run(DELETE.from(EVENTS, ENGADIN))

    expect(await readEvent(ENGADIN)).toBeUndefined()
    expect(await db.run(SELECT.from(EVENT_PHOTOS).where({ event_ID: ENGADIN }))).toHaveLength(0)
    expect(await db.run(SELECT.from(REMINDERS).where({ event_ID: ENGADIN }))).toHaveLength(0)
    expect(await db.run(SELECT.from(EVENT_PARTICIPANTS).where({ event_ID: ENGADIN }))).toHaveLength(
      0,
    )

    // CONTRACTS §10 and §11.3 rule 4: the trip is gone, the 88 francs are not.
    const detached = (await db.run(
      SELECT.from(EXPENSES).where({ merchantRaw: 'RHB BILLETT' }),
    )) as ExpenseRow[]
    expect(detached).toHaveLength(1)
    expect(detached[0].event_ID).toBeNull()
    expect(money(detached[0].amount)).toBe(88)
  })
})

/* ------------------------------------------------------------------ *
 *  Nobody owes anybody (CONTRACTS §9), including here
 * ------------------------------------------------------------------ */

describe('the vocabulary', () => {
  it('never mentions a debt, in any of the new answers', async () => {
    const calendar = await upcomingFor(AS_A, '2026-01-01', '2026-12-31')
    const totals = await periodTotalsFor(AS_A, '2026-04')
    const reminder = await asPerson(AS_A, async tx =>
      tx.send('createReminder', { eventId: ENGADIN, note: 'Book the huts.' }),
    )

    const answered = JSON.stringify({ calendar, totals, reminder })
    expect(answered).not.toMatch(/\bowes?\b|\bowed\b|balance|settle up|shareA/i)
    expect(answered).toContain('Engadin Between the Years')
  })
})
