/// <reference types="@cap-js/cds-types" />
/**
 * LedgerService handlers.
 *
 * The rule this file follows everywhere: **arithmetic lives in `srv/lib`, not
 * here.** Totals come from `lib/settlement`, rounding from `lib/money`,
 * calendars from `lib/dates`, predictions from `lib/classifier`, extraction from
 * `lib/documentai`, prose from `lib/statement` and `lib/llm`. What is left in
 * this file is the boring, important part: transactions, validation, and turning
 * a library error into an OData error a human can read.
 *
 * Nothing here computes a debt. An expense records who *paid* it and, at most,
 * which event it belongs to; `periodTotals` and `eventTotals` add those amounts
 * up, and the payment run closes a period rather than squaring anybody up
 * (CONTRACTS.md §9).
 *
 * One rule in here is subtler than the rest and worth reading twice, because a
 * plausible-looking implementation of it is wrong. A **hidden surprise**
 * (CONTRACTS.md §11.3) disappears from `Events`, `eventTotals`, `upcoming` and
 * the yearly statement for everybody but the person who created it — but its
 * **expenses go on counting everywhere**: `periodTotals`, `monthlyTotals` and
 * the Ledger list are untouched. Only the label is suppressed, never the money.
 * If a surprise's spending vanished from the month total, the hole it left would
 * announce the surprise more loudly than the event chip ever did. Everything
 * that hides an event in this file therefore filters *events*, and nothing in it
 * has ever filtered an expense. See {@link LedgerService.hideSurprises}.
 *
 * Two conventions worth knowing before reading on:
 *
 * - `await SELECT…` / `await INSERT…` inside a handler runs on `cds.db` within
 *   the *current request transaction* (`cds.context`), so every multi-statement
 *   action below is atomic without any explicit `cds.tx()` plumbing. It also
 *   means those internal writes deliberately bypass this service's own `before`
 *   validations — they are our writes, not the user's.
 * - Every rejection is `req.reject(<status>, <sentence>)`. 400 for "you asked
 *   for something the ledger does not allow", 404 for "that row is not here",
 *   502 for "an upstream service let us down".
 */
import cds from '@sap/cds'
import type { Request } from '@sap/cds'
import type {
  Correction,
  Event,
  EventParticipant,
  EventPhoto,
  Expense,
  ExpenseStatus,
  MomentCode,
  Person,
  Reminder,
  Settlement,
  SettlementStatus,
  Statement,
} from '#cds-models/twowaymatch'

import { classify as runClassifier } from './lib/classifier'
import { normaliseMerchant } from './lib/classifier/features'
import { NEEDS_REVIEW_THRESHOLD } from './lib/constants'
import { addDays, daysBetween, periodOf, todayISO } from './lib/dates'
import { getDocAiClient, mapJobResult } from './lib/documentai'
import type { ExtractedReceipt } from './lib/documentai'
import { ImageError, processReceiptImage } from './lib/images'
import { detectMood, moodDetectionConfigured } from './lib/mood'
import { MoneyError, sumMoney, toAmount, toCents } from './lib/money'
import { summariseEvent, summarisePeriod } from './lib/settlement'
import type { EventTotals, PeriodTotals, TotalsInput } from './lib/settlement'
import { aggregateYear, generateStatement as writeStatement } from './lib/statement'

const { DELETE, SELECT, INSERT, UPDATE } = cds.ql

/* ------------------------------------------------------------------ types */

/**
 * `needsReview` is the virtual element declared in `ledger-service.cds`: part of
 * the API, never a column. It only ever travels outwards, on the draft returned
 * by `scanReceipt`.
 */
type DraftExpense = Expense & { needsReview?: boolean }

interface MonthlyTotal {
  period: string
  category: string
  total: number
}

/**
 * One posting reduced to what the totals need, next to the row it came from.
 *
 * `documentNumber` rides alongside `input` rather than inside it: the arithmetic
 * has no use for it, but the period close has to be able to leave Document #1
 * alone. See {@link LedgerService.onRunSettlement}.
 */
interface TotalsLine {
  ID: string
  documentNumber: number | null
  input: TotalsInput
}

/** A person as the totals library wants them: an identity and a name to print. */
interface RosterEntry {
  ID: string
  name: string
}

/**
 * The bits of a CQN query this file has to look at directly.
 *
 * `req.subject` only carries the row filter when the caller put it in the entity
 * reference (`UPDATE(Expenses, id)`, and everything the OData adapter builds).
 * `UPDATE.entity(X).where(…)` keeps its filter one level up instead, and reading
 * the subject without it would silently inspect the *wrong row*. So both places
 * are checked. See {@link readSubjectRows}.
 */
interface FilteredQuery {
  UPDATE?: { where?: unknown[] }
  DELETE?: { where?: unknown[] }
}

/**
 * The one method {@link LedgerService.hideSurprises} calls on a READ query.
 *
 * `req.query` is a real `cds.ql` SELECT, and calling `.where()` on one that
 * already carries a `$filter` combines the two with `and` rather than replacing
 * anything — which is the whole reason the surprise filter narrows the query
 * instead of sieving the rows afterwards. Filtering after the fact would leave
 * `$count` counting rows the caller never receives, and `$top` returning short
 * pages.
 */
interface NarrowableQuery {
  where(filter: Record<string, unknown>): unknown
}

/** A minimal database handle — what `aggregateYear` accepts as its second argument. */
interface RunnableDb {
  run(query: unknown): Promise<unknown>
}

/** One line of the calendar: an event on its days, or a reminder on its due day. */
interface CalendarEntry {
  /** `Events.ID` or `Reminders.ID` — whichever row this came from. */
  ID: string
  kind: 'event' | 'reminder'
  /** `YYYY-MM-DD`; for a reminder this is `startsOn - leadDays`. */
  date: string
  /** Last day of a multi-day event; null for reminders and one-day events. */
  endsOn: string | null
  title: string
  place: string | null
  /** The event this entry is about; equal to `ID` when `kind` is `event`. */
  eventId: string
  /** True when this is a surprise only the person asking can see (§11.3). */
  onlyYou: boolean
  /** Reminders only. */
  leadDays: number | null
  /** Reminders only. */
  done: boolean | null
}

/* -------------------------------------------------------------- constants */

const DRAFT: ExpenseStatus = 'draft'
const CONFIRMED: ExpenseStatus = 'confirmed'
const OPEN: SettlementStatus = 'open'
const SETTLED: SettlementStatus = 'settled'

/** CONTRACTS §10: the first date. Read-only for everything except its note. */
const DOCUMENT_ONE = 1

/** Whoever signs off the payment run. There is only one candidate. */
const APPROVED_BY = 'CEO of the household'

/** Duplicate detection window from the brief: ±0.05 in amount, ±2 days in date. */
const DUPLICATE_TOLERANCE_CENTS = 5
const DUPLICATE_WINDOW_DAYS = 2

/**
 * CQL targets, named once.
 *
 * Plain strings rather than the linked definitions from `this.entities`, because
 * these queries are executed on `cds.db` (see the file header): the database
 * resolves the projection back to `twowaymatch.*` itself, and a string keeps the
 * handlers readable and independent of how the service was constructed.
 */
const EXPENSES = 'LedgerService.Expenses'
const RECEIPTS = 'LedgerService.Receipts'
const SETTLEMENTS = 'LedgerService.Settlements'
const STATEMENTS = 'LedgerService.Statements'
const CORRECTIONS = 'LedgerService.Corrections'
const PEOPLE = 'LedgerService.People'
const EVENTS = 'LedgerService.Events'
const EVENT_PARTICIPANTS = 'LedgerService.EventParticipants'
const EVENT_PHOTOS = 'LedgerService.EventPhotos'
const REMINDERS = 'LedgerService.Reminders'

/** The `twowaymatch` table behind `EVENTS`, as the statement's own CQN names it. */
const EVENTS_TABLE = 'twowaymatch.Events'

const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const ISO_4217_PATTERN = /^[A-Za-z]{3}$/

/** Everything the surprise rules in §11.3 need to read off an event. */
const SURPRISE_COLUMNS = ['ID', 'isSurprise', 'revealedAt', 'startsOn', 'createdBy_ID'] as const

/** Plus what the calendar prints. One query serves both. */
const CALENDAR_COLUMNS = [...SURPRISE_COLUMNS, 'name', 'endsOn', 'place'] as const

/** CONTRACTS §11.2: a reminder fires the day before, unless it is told otherwise. */
const DEFAULT_LEAD_DAYS = 1

/** A year of notice is generous; more is a typo, and a negative lead is nonsense. */
const MAX_LEAD_DAYS = 365

/** `String(200)` in the model, for both a reminder's note and a photo's caption. */
const MAX_TEXT_LENGTH = 200

/** Events come before reminders on the same day: the thing, then the nudge about it. */
const CALENDAR_KIND_ORDER: Readonly<Record<CalendarEntry['kind'], number>> = {
  event: 0,
  reminder: 1,
}

/**
 * Fields a caller may send on an update to Document #1, plus the technical ones
 * CAP fills in by itself (`modifiedAt`/`modifiedBy` come from the `managed`
 * aspect and are not the user asking to change anything).
 */
const DOCUMENT_ONE_WRITABLE: ReadonlySet<string> = new Set([
  'note',
  'ID',
  'createdAt',
  'createdBy',
  'modifiedAt',
  'modifiedBy',
])

/* ------------------------------------------------------------------ utils */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A message safe to put in an OData error: no stacks, no payloads. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

/** `YYYY-MM-DD` + `HH:MM:SS` → the `whenISO` the classifier and `lib/dates` expect. */
function whenISO(date: string | null | undefined, time: string | null | undefined): string {
  const day = typeof date === 'string' && date !== '' ? date.slice(0, 10) : todayISO()
  if (typeof time !== 'string' || time.length < 5) return day
  return `${day}T${time.slice(0, 5)}`
}

/**
 * Writes the canonical spelling of an ISO-4217 code into the payload.
 *
 * The rule in {@link LedgerService.validateExpenseWrite} is deliberately
 * case-insensitive, so a client that lower-cases its JSON is not turned away.
 * Storing what it sent verbatim would be the real damage: `chf` and `CHF` are one
 * currency that every total, chart and statement would then count as two. The
 * code is upper-cased on the way in, exactly like `merchantNorm` is derived on
 * the way in, so the database only ever holds the canonical form.
 */
function canonicaliseCurrency(data: Record<string, unknown>): void {
  if (typeof data.currency === 'string' && ISO_4217_PATTERN.test(data.currency)) {
    data.currency = data.currency.toUpperCase()
  }
}

/** Reads a `Decimal` that may arrive as a number or as a driver-formatted string. */
function amountOf(value: unknown): number | null {
  if (value === null || value === undefined) return null
  try {
    return toAmount(value)
  } catch {
    return null
  }
}

/**
 * Loads *every* row an UPDATE or DELETE is about to touch.
 *
 * All of them, not just the first: `DELETE.from(Expenses).where({date: …})` is a
 * legal request, and a guard that inspected one arbitrary row would happily let
 * it take Document #1 with it. Both filter locations are honoured too — see
 * {@link FilteredQuery} for why that is not paranoia but correctness.
 */
async function readSubjectRows<T>(req: Request, columns: readonly string[]): Promise<T[]> {
  const query = SELECT.from(req.subject).columns(...columns)
  const filtered = req.query as unknown as FilteredQuery
  const extra = filtered.UPDATE?.where ?? filtered.DELETE?.where
  if (Array.isArray(extra) && extra.length > 0) query.where(extra)
  const rows = (await query) as T[] | null
  return rows ?? []
}

/**
 * Identity of a logged correction: which head, what the model said, what the
 * human said. The separator is a NUL because it cannot occur in a category or
 * moment code, so no pair of different triples can collide into one key.
 */
function correctionKey(row: Correction): string {
  return `${row.field ?? ''}\u0000${row.predicted ?? ''}\u0000${row.corrected ?? ''}`
}

/** An INSERT of several rows hands `req.data` an array; a single row does not. */
function payloadRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter(isRecord)
  return isRecord(data) ? [data] : []
}

/** The person a participant payload names, however the client chose to write it. */
function personIdOf(entry: Record<string, unknown>): string | null {
  const direct = entry.person_ID
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = entry.person
  if (isRecord(nested) && typeof nested.ID === 'string' && nested.ID !== '') return nested.ID
  return null
}

/** `1 posting` / `4 postings`, so the refusal below reads like a sentence. */
function postingCount(count: number): string {
  return count === 1 ? '1 posting' : `${count} postings`
}

/** `YYYY-MM-DD` out of a driver value that may carry a time, or null if it is not one. */
function dateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const date = value.slice(0, 10)
  return DATE_PATTERN.test(date) ? date : null
}

/** True when a nullable column actually holds something. */
function isSet(value: unknown): boolean {
  if (value === null || value === undefined) return false
  return !(typeof value === 'string' && value.trim() === '')
}

/** Trimmed text out of an action parameter, or null when the caller sent nothing. */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * Is this event still a secret from *somebody*?
 *
 * CONTRACTS §11.3: a surprise stops being one when `revealedAt` is stamped or
 * when `startsOn` arrives, whichever comes first. The day itself counts as
 * arrived — on the morning of the surprise weekend there is nothing left to
 * spoil, and an event that stayed hidden through its own first day would be
 * missing from the calendar on the one day it matters.
 *
 * An event with no `startsOn` at all has no day that can arrive, so only an
 * explicit reveal opens it.
 */
function isSecret(event: Event, today: string): boolean {
  if (event.isSurprise !== true) return false
  if (isSet(event.revealedAt)) return false
  const startsOn = dateOf(event.startsOn)
  return startsOn === null || startsOn > today
}

/**
 * …and is it a secret *from this particular viewer*?
 *
 * The creator sees their own surprise; everybody else does not. A surprise with
 * no creator is hidden from everybody, and so is every surprise when nobody
 * could be identified — this fails closed on purpose. Showing a secret to the
 * wrong person cannot be undone; hiding one for a moment can.
 */
function isHiddenFrom(event: Event, viewerId: string | null, today: string): boolean {
  if (!isSecret(event, today)) return false
  const creator = event.createdBy_ID ?? null
  return creator === null || viewerId === null || creator !== viewerId
}

/**
 * The name the logged-in user goes by, lower-cased, or `''` when there is none.
 *
 * CAP's mocked authentication puts a login name in `user.id` and, when the
 * configuration gives one, a display name in `user.attr.name`. Neither is a
 * `People.ID`, which is why {@link LedgerService.viewer} matches on text and
 * falls back rather than trusting it.
 */
function claimedIdentity(req: Request): string {
  const user: unknown = req.user
  if (!isRecord(user)) return ''
  const attr = isRecord(user.attr) ? user.attr : {}
  for (const candidate of [attr.name, attr.fullName, user.id]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim().toLowerCase()
    }
  }
  return ''
}

/**
 * Does this CQN read the events table?
 *
 * Used by {@link LedgerService.onGenerateStatement} to sieve exactly one of the
 * five queries `aggregateYear` issues. Matching the table name rather than the
 * service entity is deliberate: `srv/lib/statement.ts` builds its own CQN
 * against `twowaymatch.*` and is not this file's to change.
 */
function readsEventsTable(query: unknown): boolean {
  if (!isRecord(query)) return false
  const select = query.SELECT
  if (!isRecord(select)) return false
  const from = select.from
  if (!isRecord(from)) return false
  const ref = from.ref
  return Array.isArray(ref) && ref[0] === EVENTS_TABLE
}

/** Calendar order: by day, then the event before the nudge, then by title. */
function byCalendarOrder(a: CalendarEntry, b: CalendarEntry): number {
  return (
    a.date.localeCompare(b.date) ||
    CALENDAR_KIND_ORDER[a.kind] - CALENDAR_KIND_ORDER[b.kind] ||
    a.title.localeCompare(b.title) ||
    a.ID.localeCompare(b.ID)
  )
}

/* ---------------------------------------------------------------- service */

export default class LedgerService extends cds.ApplicationService {
  /**
   * Handler registration.
   *
   * Every action handler is a method named `on<Action>`, never `<action>`. That
   * is not a style choice: `@sap/cds` scans a service implementation for methods
   * whose names match a declared action and, when it finds one, registers its
   * own `on` handler that calls the method with the action's parameters spread
   * out **positionally** — and then replaces the method with a request-sending
   * stub. A method called `runSettlement(req)` would therefore be invoked as
   * `runSettlement(period)` and would never see a `Request` to reject with. The
   * prefix keeps the framework's convenience feature out of the way while the
   * handlers below stay explicit about what they receive.
   */
  override async init(): Promise<void> {
    /* -------------------------------------------------------- validation */

    this.before(['CREATE', 'UPDATE'], 'Expenses', req => this.validateExpenseWrite(req))
    this.before('DELETE', 'Expenses', req => this.guardDocumentOneDelete(req))
    this.before(['CREATE', 'UPDATE'], 'Events', req => this.validateEventWrite(req))
    this.before('CREATE', 'EventParticipants', req => this.validateParticipantWrite(req))
    this.before(['CREATE', 'UPDATE'], 'EventPhotos', req => this.guardRawPhotoWrite(req))

    /* -------------------------------------------------- surprises (§11.3) */

    // Four entities, one rule: an event nobody but its creator may see takes
    // its guest list, its pictures and its reminders with it. Expenses are
    // conspicuously absent from this list — see the file header.
    for (const entity of ['Events', 'EventParticipants', 'EventPhotos', 'Reminders'] as const) {
      this.before('READ', entity, req => this.hideSurprises(req, entity))
    }

    /* ----------------------------------------------------------- removal */

    this.before('DELETE', 'People', req => this.removePerson(req))
    this.before('DELETE', 'Events', req => this.detachEventExpenses(req))

    /* -------------------------------------------------------- enrichment */

    this.before('CREATE', 'Expenses', req => this.enrichOnCreate(req))
    this.before('UPDATE', 'Expenses', req => this.renormaliseOnUpdate(req))
    this.before('CREATE', 'Events', req => this.stampEventCreator(req))

    /* ------------------------------------------------------------ actions */

    this.on('confirmExpense', req => this.onConfirmExpense(req))
    this.on('periodTotals', req => this.onPeriodTotals(req))
    this.on('eventTotals', req => this.onEventTotals(req))
    this.on('runSettlement', req => this.onRunSettlement(req))
    this.on('markSettled', req => this.onMarkSettled(req))
    this.on('monthlyTotals', req => this.onMonthlyTotals(req))
    this.on('duplicates', req => this.onDuplicates(req))
    this.on('classify', req => this.onClassify(req))
    this.on('scanReceipt', req => this.onScanReceipt(req))
    this.on('detectMood', req => this.onDetectMood(req))
    this.on('generateStatement', req => this.onGenerateStatement(req))
    this.on('addEventPhoto', req => this.onAddEventPhoto(req))
    this.on('deleteEventPhoto', req => this.onDeleteEventPhoto(req))
    this.on('revealSurprise', req => this.onRevealSurprise(req))
    this.on('createReminder', req => this.onCreateReminder(req))
    this.on('completeReminder', req => this.onCompleteReminder(req))
    this.on('upcoming', req => this.onUpcoming(req))

    await super.init()
  }

  /* ================================================================= rules */

  /**
   * The inbound-write rules, in the order a human would check them.
   *
   * Every one of them is deliberately conditional on the field being *present in
   * the payload*: this is validation of what the caller asked for, never a
   * constraint on what is already stored. That distinction is the whole reason
   * Document #1 can keep its amount of 0.00 (CONTRACTS §10) while nobody is
   * allowed to write a zero amount today.
   */
  private async validateExpenseWrite(req: Request): Promise<void> {
    // Document #1 first: it is the most specific rule, so it gives the most
    // useful message when several of them would apply at once.
    const affected =
      req.event === 'UPDATE'
        ? await readSubjectRows<Expense>(req, ['ID', 'documentNumber', 'status', 'settlement_ID'])
        : []
    const documentOne = affected.find(row => row.documentNumber === DOCUMENT_ONE)

    for (const data of payloadRows(req.data)) {
      if (documentOne) {
        const attempted = Object.keys(data).filter(key => !DOCUMENT_ONE_WRITABLE.has(key))
        if (attempted.length > 0) {
          req.reject(
            400,
            `Document #1 is read-only except for its note; cannot change ${attempted.join(', ')}.`,
          )
        }
      }

      if ('amount' in data && data.amount !== null && data.amount !== undefined) {
        let amount: number
        try {
          amount = toAmount(data.amount)
        } catch (error) {
          req.reject(400, error instanceof MoneyError ? error.message : describeError(error))
        }
        if (!(amount > 0)) req.reject(400, `amount must be greater than 0, got ${amount}.`)
      }

      if ('currency' in data && data.currency !== null && data.currency !== undefined) {
        const currency = String(data.currency)
        if (!ISO_4217_PATTERN.test(currency)) {
          req.reject(
            400,
            `currency must be a three-letter ISO-4217 code, got ${JSON.stringify(currency)}.`,
          )
        }
      }

      // An expense belongs either to an event that exists or to no event at all
      // (CONTRACTS §10). A dangling `event_ID` would fall out of both reports:
      // `eventTotals` has no such event to ask about, and the everyday view
      // filters on the field being null. Money in the ledger and in no total.
      if ('event_ID' in data && data.event_ID !== null && data.event_ID !== undefined) {
        const eventId = String(data.event_ID)
        const event = (await SELECT.one
          .from(EVENTS)
          .columns('ID')
          .where({ ID: eventId })) as Event | null
        if (!event) {
          req.reject(400, `there is no event with ID ${eventId}; create the event first.`)
        }
      }

      // A draft is an unposted document: it carries no document number, so
      // there is nothing for a clearing document to cover. The status the row
      // will *end up* with decides — the one in this payload if it says, the
      // stored one otherwise. A CREATE has nothing stored, so it has to say.
      if ('settlement_ID' in data && data.settlement_ID !== null) {
        const declared = data.status as ExpenseStatus | undefined
        const staysDraft =
          declared !== undefined
            ? declared !== CONFIRMED
            : affected.length === 0 || affected.some(row => row.status !== CONFIRMED)
        if (staysDraft) {
          req.reject(
            400,
            'a draft cannot be closed — confirm the expense before adding it to a clearing document.',
          )
        }
      }
    }
  }

  /** Read-only means read-only: Document #1 cannot be deleted either. */
  private async guardDocumentOneDelete(req: Request): Promise<void> {
    const affected = await readSubjectRows<Expense>(req, ['ID', 'documentNumber'])
    if (affected.some(row => row.documentNumber === DOCUMENT_ONE)) {
      req.reject(400, 'Document #1 is read-only and cannot be deleted.')
    }
  }

  /**
   * An event is a name, some dates and a guest list — and the guest list has to
   * be made of people the ledger already knows.
   *
   * One rule covers both ways in: the deep payload the UI sends when it creates
   * an event together with its participants, and the same array replayed on an
   * update. Adding one person to an event that already exists goes through
   * {@link validateParticipantWrite} instead.
   */
  private async validateEventWrite(req: Request): Promise<void> {
    for (const data of payloadRows(req.data)) {
      // §11.3's `createdBy` is the one person a surprise is *not* hidden from,
      // so an id naming nobody would hide the event from everybody — including
      // whoever planned it. Checked here rather than left to a foreign key,
      // which SQLite would report as a five-word constraint violation.
      if (isSet(data.createdBy_ID)) {
        await this.requirePeopleExist(req, [String(data.createdBy_ID)])
      }

      if (!Array.isArray(data.participants)) continue

      const wanted: string[] = []
      for (const entry of data.participants) {
        if (!isRecord(entry)) {
          req.reject(400, 'every participant of an event is a row naming a person.')
        }
        const personId = personIdOf(entry)
        if (personId === null) {
          req.reject(400, 'every participant of an event needs a person in "person_ID".')
        }
        // The composite key of EventParticipants refuses a repeat by itself, but
        // it does so as a constraint violation from the driver. Saying it in
        // words here is the difference between a fixable message and a 500.
        if (wanted.includes(personId)) {
          req.reject(400, `person ${personId} is on this event twice; each person joins once.`)
        }
        wanted.push(personId)
      }

      await this.requirePeopleExist(req, wanted)
    }
  }

  /** One person added to one event, once the event and the person are both real. */
  private async validateParticipantWrite(req: Request): Promise<void> {
    for (const data of payloadRows(req.data)) {
      const eventId = data.event_ID
      if (typeof eventId !== 'string' || eventId === '') {
        req.reject(400, 'a participant needs the event to join in "event_ID".')
      }
      const personId = personIdOf(data)
      if (personId === null) {
        req.reject(400, 'a participant needs the person joining in "person_ID".')
      }

      const event = (await SELECT.one
        .from(EVENTS)
        .columns('ID')
        .where({ ID: eventId })) as Event | null
      if (!event) req.reject(404, `there is no event with ID ${eventId}.`)
      await this.requirePeopleExist(req, [personId])
    }
  }

  /**
   * Photographs arrive through {@link onAddEventPhoto} and nowhere else.
   *
   * The action strips EXIF, rotates, downscales and re-encodes before a single
   * byte reaches the database (CONTRACTS §11.1). A plain `POST /EventPhotos`
   * with an inline `image` would walk straight past all of that and store a
   * phone photo complete with its GPS coordinates, its device serial and the
   * exact second it was taken — in a private household ledger. So the direct
   * write is refused, and the refusal names the way in.
   *
   * Editing a caption is not a write of image bytes and is left alone: the
   * guard only fires on payloads that actually carry an image, plus every
   * CREATE, because a photo row without a photo is not worth having.
   */
  private guardRawPhotoWrite(req: Request): void {
    for (const data of payloadRows(req.data)) {
      if (req.event === 'CREATE' || 'image' in data) {
        req.reject(
          400,
          'photographs are uploaded with the addEventPhoto action, which strips their ' +
            'metadata and downscales them before anything is stored.',
        )
      }
    }
  }

  /**
   * Hidden surprises, out of every read that could name one (CONTRACTS §11.3).
   *
   * The query is *narrowed* rather than the rows sieved afterwards, so `$count`
   * counts what the caller can actually see and a page of ten is ten. Calling
   * `.where()` on a query that already carries a `$filter` combines the two with
   * `and`; it never replaces one.
   *
   * The filter is an id list rather than a clause about `isSurprise`,
   * `revealedAt`, `startsOn` and `createdBy_ID`, because the same four columns
   * would then be re-implemented in CQN next to the TypeScript in
   * {@link isHiddenFrom}, and the two would drift. A household has a handful of
   * surprises at a time, and the list is normally empty — in which case this
   * costs one indexed read and adds nothing to the query.
   *
   * Note what is *not* in the entity list this is registered for: `Expenses`.
   * A hidden surprise's postings stay in the Ledger, in `periodTotals` and in
   * `monthlyTotals`, exactly as ordinary spending. Only the label is hidden.
   */
  private async hideSurprises(
    req: Request,
    entity: 'Events' | 'EventParticipants' | 'EventPhotos' | 'Reminders',
  ): Promise<void> {
    const hidden = await this.hiddenSurpriseIds(req)
    if (hidden.length === 0) return

    const column = entity === 'Events' ? 'ID' : 'event_ID'
    const query = req.query as unknown as NarrowableQuery
    query.where({ [column]: { 'not in': hidden } })
  }

  /**
   * Every event remembers who planned it.
   *
   * Without this a surprise created from the UI would have no `createdBy`, and
   * {@link isHiddenFrom} fails closed on exactly that — the event would be
   * invisible to its own author. The caller may name somebody else explicitly
   * (and {@link validateEventWrite} checks that they exist); when it says
   * nothing, the person asking gets the credit.
   */
  private async stampEventCreator(req: Request): Promise<void> {
    const unclaimed = payloadRows(req.data).filter(data => !isSet(data.createdBy_ID))
    if (unclaimed.length === 0) return

    const me = await this.viewer(req)
    if (me === null) return
    for (const data of unclaimed) data.createdBy_ID = me.ID
  }

  /**
   * Taking somebody off the roster.
   *
   * A person who has paid for something is part of the ledger's history, and
   * deleting them would leave every one of those postings pointing at nobody — so
   * it is refused, with the count, and the fix is to move those expenses to
   * somebody else first. A person who has never paid for anything is simply
   * removed, and their event memberships go with them: a membership is a fact
   * about a pairing, not a record of anything that happened.
   */
  private async removePerson(req: Request): Promise<void> {
    const people = await readSubjectRows<Person>(req, ['ID', 'name'])
    if (people.length === 0) return
    const ids = people.map(person => String(person.ID))

    const paid = (await SELECT.from(EXPENSES)
      .columns('paidBy_ID')
      .where({ paidBy_ID: { in: ids } })) as Expense[]
    if (paid.length > 0) {
      const counts = new Map<string, number>()
      for (const row of paid) {
        const id = String(row.paidBy_ID)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      const blocked = people
        .filter(person => counts.has(String(person.ID)))
        .map(person => {
          const name = person.name ?? String(person.ID)
          return `${name} (${postingCount(counts.get(String(person.ID)) ?? 0)})`
        })
      req.reject(
        400,
        `${blocked.join(', ')} cannot be removed while those postings are in the ledger — ` +
          'move them to somebody else first.',
      )
    }

    await DELETE.from(EVENT_PARTICIPANTS).where({ person_ID: { in: ids } })
  }

  /**
   * Deleting an event detaches its expenses; it never deletes them (CONTRACTS §10).
   *
   * The trip was cancelled, or entered twice, or turned out to be two trips —
   * none of which is a reason to lose what was spent. Those postings become
   * everyday spending again, which is exactly what `event = null` means, and they
   * go on counting toward their period either way. The participants *do* go with
   * the event: they are a composition, and a guest list without an event is not a
   * fact about anybody.
   */
  private async detachEventExpenses(req: Request): Promise<void> {
    const events = await readSubjectRows<Event>(req, ['ID'])
    if (events.length === 0) return
    const ids = events.map(event => String(event.ID))

    await UPDATE.entity(EXPENSES)
      .set({ event_ID: null })
      .where({ event_ID: { in: ids } })
  }

  /** Every id has to name a row in `People`, or the write says which one does not. */
  private async requirePeopleExist(req: Request, ids: readonly string[]): Promise<void> {
    const wanted = [...new Set(ids)]
    if (wanted.length === 0) return

    const found = (await SELECT.from(PEOPLE)
      .columns('ID')
      .where({ ID: { in: wanted } })) as Person[]
    const known = new Set(found.map(person => String(person.ID)))
    const missing = wanted.filter(id => !known.has(id))
    if (missing.length > 0) {
      req.reject(
        400,
        `there is nobody in the ledger with ID ${missing.join(', ')} — add the person first.`,
      )
    }
  }

  /* ============================================================ enrichment */

  /**
   * Automatic classification on CREATE.
   *
   * `merchantNorm` and `currency` are derived data, so they are recomputed rather
   * than trusted, and the two heads only run when the caller left `category`
   * empty — a human who picked a category is not to be second-guessed by a model.
   */
  private async enrichOnCreate(req: Request): Promise<void> {
    for (const data of payloadRows(req.data)) {
      canonicaliseCurrency(data)

      const merchantRaw = typeof data.merchantRaw === 'string' ? data.merchantRaw : ''
      if (merchantRaw === '') continue

      data.merchantNorm = normaliseMerchant(merchantRaw)
      if (typeof data.category_code === 'string' && data.category_code !== '') continue

      const date = typeof data.date === 'string' ? data.date : null
      const time = typeof data.time === 'string' ? data.time : null
      const result = await runClassifier(
        merchantRaw,
        amountOf(data.amount) ?? 0,
        whenISO(date, time),
      )
      data.category_code = result.category
      data.categoryConfidence = result.categoryConfidence
      data.moment = result.moment
      data.momentConfidence = result.momentConfidence
    }
  }

  /**
   * Keeps the derived fields in step with a hand-edited row: the duplicate key
   * when a merchant name is corrected, the canonical currency code when one is
   * re-typed. Same two derivations as on CREATE, for the same reason.
   */
  private renormaliseOnUpdate(req: Request): void {
    for (const data of payloadRows(req.data)) {
      canonicaliseCurrency(data)
      if (typeof data.merchantRaw === 'string' && data.merchantRaw !== '') {
        data.merchantNorm = normaliseMerchant(data.merchantRaw)
      }
    }
  }

  /* =============================================================== actions */

  /**
   * Post a draft.
   *
   * **On the atomicity of `documentNumber`.** The number is taken as
   * `max(documentNumber) + 1` inside the request transaction, immediately before
   * the UPDATE that stores it. That is honest but not bulletproof: `SELECT max`
   * takes no write lock, so two transactions that both read before either writes
   * would compute the same number, and only a unique index — which the schema
   * does not have, and the schema is not ours to change — would stop the second
   * one. In practice SQLite serialises writers with a database-level write lock,
   * and the people using this app post expenses by tapping a button: the window
   * is milliseconds wide and needs two of them inside it at once. It is
   * documented rather than hidden. On a server backed by a genuinely concurrent
   * database this wants `SELECT … FOR UPDATE` or a number-range table.
   */
  private async onConfirmExpense(req: Request): Promise<Expense> {
    const data = req.data as Record<string, unknown>
    const id = String(data.ID ?? '')
    if (id === '') req.reject(400, 'confirmExpense needs the ID of the expense to post.')

    const expense = (await SELECT.one
      .from(EXPENSES)
      .columns('ID', 'documentNumber', 'status', 'category_code', 'moment')
      .where({ ID: id })) as Expense | null
    if (!expense) req.reject(404, `there is no expense with ID ${id}.`)
    if (expense.documentNumber === DOCUMENT_ONE) {
      req.reject(400, 'Document #1 is read-only except for its note; it is already posted.')
    }

    let documentNumber = expense.documentNumber ?? null
    if (documentNumber === null) {
      const highest = (await SELECT.one
        .from(EXPENSES)
        .columns({ func: 'max', args: [{ ref: ['documentNumber'] }], as: 'highest' })) as {
        highest?: number | null
      } | null
      documentNumber = (highest?.highest ?? 0) + 1
    }

    await UPDATE.entity(EXPENSES).set({ status: CONFIRMED, documentNumber }).where({ ID: id })

    // Corrections are the entire input to the next training round, so they log
    // the human's verdict: `predicted` is what the caller says was shown,
    // `corrected` is what is actually stored now.
    const predictedCategory =
      typeof data.predictedCategory === 'string' ? data.predictedCategory : ''
    const predictedMoment = typeof data.predictedMoment === 'string' ? data.predictedMoment : ''
    const finalCategory = expense.category_code ?? ''
    const finalMoment = expense.moment ?? ''
    const corrections: Correction[] = []
    if (predictedCategory !== '' && predictedCategory !== finalCategory) {
      corrections.push({
        ID: cds.utils.uuid(),
        expense_ID: id,
        field: 'category',
        predicted: predictedCategory,
        corrected: finalCategory,
      })
    }
    if (predictedMoment !== '' && predictedMoment !== finalMoment) {
      corrections.push({
        ID: cds.utils.uuid(),
        expense_ID: id,
        field: 'moment',
        predicted: predictedMoment,
        corrected: finalMoment,
      })
    }
    // Posting is idempotent — a second confirm keeps the document number the row
    // already has — and the training log has to be idempotent with it. A double
    // tap on "Post", or an OData client retrying a request whose response it
    // never saw, must not teach the next training round the same correction
    // twice: duplicated rows would silently weight that one disagreement double.
    // Only an *identical* (field, predicted, corrected) triple is suppressed, so
    // a genuinely different correction made later is still recorded.
    //
    // `createdAt` is deliberately absent: Corrections declares
    // `@cds.on.insert: $now`, and sending a value would override that stamp.
    if (corrections.length > 0) {
      const logged = (await SELECT.from(CORRECTIONS)
        .columns('field', 'predicted', 'corrected')
        .where({ expense_ID: id })) as Correction[]
      const seen = new Set(logged.map(correctionKey))
      const unlogged = corrections.filter(row => !seen.has(correctionKey(row)))
      if (unlogged.length > 0) await INSERT.into(CORRECTIONS).entries(unlogged)
    }

    return (await SELECT.one.from(EXPENSES).where({ ID: id })) as Expense
  }

  /**
   * What a month came to, and who paid for it.
   *
   * Every confirmed posting dated in the period counts, whether or not the month
   * has since been closed: a report that emptied itself the moment somebody
   * pressed "Payment run" would be a strange kind of report. The arithmetic is
   * `lib/settlement.summarisePeriod` and is not reimplemented here — this handler
   * only decides which rows it sees, and hands it the whole roster so that
   * somebody who paid for nothing this month still gets a line at 0.00.
   */
  private async onPeriodTotals(req: Request): Promise<PeriodTotals> {
    const period = this.requirePeriod(req, (req.data as Record<string, unknown>).period, 'period')
    const lines = await this.totalsLines({ period })
    const roster = await this.roster()

    try {
      return summarisePeriod(
        lines.map(line => line.input),
        period,
        roster,
      )
    } catch (error) {
      return req.reject(
        400,
        `the totals for ${period} could not be computed: ${describeError(error)}`,
      )
    }
  }

  /**
   * What one trip, dinner or party came to.
   *
   * The roster here is the event's own participants rather than everybody, which
   * is what makes `perHead` mean anything: the total divided by the people who
   * were there. It is context for the screen — "CHF 254.60 each" — and never a
   * bill anybody is being sent (CONTRACTS §9).
   */
  private async onEventTotals(req: Request): Promise<EventTotals> {
    // A hidden surprise is not here for anybody but its creator (CONTRACTS
    // §11.3 rule 1) — and it answers as if it did not exist, because a total is
    // a very loud way to admit that something is being planned. The postings
    // underneath it are untouched: they are still in `periodTotals`, still in
    // `monthlyTotals`, still in the Ledger. Only this label is missing.
    const event = await this.requireVisibleEvent(
      req,
      (req.data as Record<string, unknown>).eventId,
      'eventTotals',
      'eventId',
    )
    const id = String(event.ID)

    const lines = await this.totalsLines({ eventId: id })
    const participants = await this.participantsOf(id)

    try {
      return summariseEvent(
        lines.map(line => line.input),
        { ID: id, name: event.name ?? '' },
        participants,
      )
    } catch (error) {
      return req.reject(
        400,
        `the totals for event ${id} could not be computed: ${describeError(error)}`,
      )
    }
  }

  /**
   * The monthly payment run, which closes a period rather than settling a debt.
   *
   * It writes one `Settlements` row recording what the period totalled and links
   * the lines it covered, so the month can be marked done and read back later.
   * No money moves: `clearingDocument` and `approvedBy` are the joke, and the
   * arithmetic underneath them is a sum (CONTRACTS §9).
   *
   * A period is closed once — a second run would produce a second document
   * covering nothing — and that "once" is enforced by a read-then-write inside
   * the request transaction, with exactly the caveat spelled out on
   * {@link onConfirmExpense}: no unique index exists on `period`, so two runs
   * racing each other could both find no clearing document and both write one.
   * SQLite serialises writers and the button is tapped by a human, but on a
   * genuinely concurrent database this wants a constraint rather than a comment.
   */
  private async onRunSettlement(req: Request): Promise<Settlement> {
    const period = this.requirePeriod(req, (req.data as Record<string, unknown>).period, 'period')

    const closed = (await SELECT.one
      .from(SETTLEMENTS)
      .columns('ID', 'clearingDocument')
      .where({ period })) as Settlement | null
    if (closed) {
      const document = closed.clearingDocument ?? 'a clearing document'
      req.reject(400, `period ${period} has already been closed by ${document}.`)
    }

    // CONTRACTS §10: Document #1 is read-only except for its note, and that has
    // to hold for the payment run too. It is a CHF 0.00 row, so leaving it out
    // changes no total anywhere — but a run over June 2024 would otherwise stamp
    // a `settlement` on the one row nothing may write to, and turn the month of
    // the first date into a clearing document for nothing at all.
    const lines = (await this.totalsLines({ period, unclosedOnly: true })).filter(
      line => line.documentNumber !== DOCUMENT_ONE,
    )
    if (lines.length === 0) {
      req.reject(400, `there is nothing to close in ${period}: no confirmed, open expenses.`)
    }

    const totals = summarisePeriod(
      lines.map(line => line.input),
      period,
      await this.roster(),
    )
    const ID = cds.utils.uuid()
    await INSERT.into(SETTLEMENTS).entries({
      ID,
      period,
      grandTotal: totals.grandTotal,
      status: OPEN,
      clearingDocument: `CLR-${period}`,
      approvedBy: APPROVED_BY,
    })
    await UPDATE.entity(EXPENSES)
      .set({ settlement_ID: ID })
      .where({ ID: { in: lines.map(line => line.ID) } })

    return (await SELECT.one.from(SETTLEMENTS).where({ ID })) as Settlement
  }

  /** Flips a closed period to done and stamps when that happened. */
  private async onMarkSettled(req: Request): Promise<Settlement> {
    const id = String((req.data as Record<string, unknown>).ID ?? '')
    if (id === '') req.reject(400, 'markSettled needs the ID of the clearing document.')

    const settlement = (await SELECT.one
      .from(SETTLEMENTS)
      .columns('ID', 'status', 'clearingDocument')
      .where({ ID: id })) as Settlement | null
    if (!settlement) req.reject(404, `there is no clearing document with ID ${id}.`)
    if (settlement.status === SETTLED) {
      req.reject(
        400,
        `${settlement.clearingDocument ?? 'this clearing document'} is already settled.`,
      )
    }

    await UPDATE.entity(SETTLEMENTS)
      .set({ status: SETTLED, settledAt: new Date().toISOString() })
      .where({ ID: id })
    return (await SELECT.one.from(SETTLEMENTS).where({ ID: id })) as Settlement
  }

  /**
   * Period × category totals for the charts.
   *
   * Bucketed in TypeScript rather than in SQL on purpose: `sumMoney` rounds once
   * at the end (CONTRACTS §9), which `SUM()` over a `Decimal` column in SQLite
   * does not promise. A household's worth of rows a month makes this free.
   */
  private async onMonthlyTotals(req: Request): Promise<MonthlyTotal[]> {
    const data = req.data as Record<string, unknown>
    const fromPeriod = this.requirePeriod(req, data.fromPeriod, 'fromPeriod')
    const toPeriod = this.requirePeriod(req, data.toPeriod, 'toPeriod')
    if (fromPeriod > toPeriod) {
      req.reject(400, `fromPeriod ${fromPeriod} is after toPeriod ${toPeriod}.`)
    }

    const rows = (await SELECT.from(EXPENSES)
      .columns('date', 'category_code', 'amount')
      .where({ status: CONFIRMED })) as Expense[]

    const buckets = new Map<string, number[]>()
    for (const row of rows) {
      const amount = amountOf(row.amount)
      if (typeof row.date !== 'string' || amount === null) continue
      const period = periodOf(row.date)
      if (period < fromPeriod || period > toPeriod) continue
      // An empty category means "confirmed but never classified". It cannot
      // collide with a code from CONTRACTS §1.1, so a chart can label it safely.
      const key = `${period} ${row.category_code ?? ''}`
      const bucket = buckets.get(key)
      if (bucket) bucket.push(amount)
      else buckets.set(key, [amount])
    }

    return [...buckets.entries()]
      .map(([key, amounts]) => {
        const separator = key.indexOf(' ')
        return {
          period: key.slice(0, separator),
          category: key.slice(separator + 1),
          total: sumMoney(amounts),
        }
      })
      .sort((a, b) => a.period.localeCompare(b.period) || a.category.localeCompare(b.category))
  }

  /**
   * The same purchase, booked twice.
   *
   * `merchantNorm` has to match exactly — that is what normalising it is for —
   * the amount is compared in integer cents so ±0.05 means exactly ±0.05, and
   * the date window is calendar days from `lib/dates` rather than milliseconds.
   */
  private async onDuplicates(req: Request): Promise<Expense[]> {
    const id = String((req.data as Record<string, unknown>).ID ?? '')
    if (id === '') req.reject(400, 'duplicates needs the ID of the expense to compare.')

    const self = (await SELECT.one.from(EXPENSES).where({ ID: id })) as Expense | null
    if (!self) req.reject(404, `there is no expense with ID ${id}.`)

    const amount = amountOf(self.amount)
    const date = self.date
    if (!self.merchantNorm || typeof date !== 'string' || amount === null) return []
    const cents = toCents(amount)

    const candidates = (await SELECT.from(EXPENSES).where({
      merchantNorm: self.merchantNorm,
      ID: { '!=': id },
    })) as Expense[]

    return candidates.filter(candidate => {
      const other = amountOf(candidate.amount)
      if (typeof candidate.date !== 'string' || other === null) return false
      if (Math.abs(toCents(other) - cents) > DUPLICATE_TOLERANCE_CENTS) return false
      return Math.abs(daysBetween(date, candidate.date)) <= DUPLICATE_WINDOW_DAYS
    })
  }

  /** Re-runs both heads over one expense and stores what they said. */
  private async onClassify(req: Request): Promise<Expense> {
    const id = String((req.data as Record<string, unknown>).ID ?? '')
    if (id === '') req.reject(400, 'classify needs the ID of the expense to classify.')

    const expense = (await SELECT.one.from(EXPENSES).where({ ID: id })) as Expense | null
    if (!expense) req.reject(404, `there is no expense with ID ${id}.`)
    if (expense.documentNumber === DOCUMENT_ONE) {
      req.reject(400, 'Document #1 is read-only except for its note; it will not be reclassified.')
    }
    const merchantRaw = expense.merchantRaw ?? ''
    if (merchantRaw === '') {
      req.reject(400, `expense ${id} has no merchant name, so there is nothing to classify.`)
    }

    const result = await runClassifier(
      merchantRaw,
      amountOf(expense.amount) ?? 0,
      whenISO(expense.date, expense.time),
    )
    await UPDATE.entity(EXPENSES)
      .set({
        merchantNorm: normaliseMerchant(merchantRaw),
        category_code: result.category,
        categoryConfidence: result.categoryConfidence,
        moment: result.moment as MomentCode,
        momentConfidence: result.momentConfidence,
      })
      .where({ ID: id })

    return (await SELECT.one.from(EXPENSES).where({ ID: id })) as Expense
  }

  /**
   * Photo in, draft expense out.
   *
   * The order is not negotiable: the image is normalised **before** it is stored,
   * so no EXIF (GPS, device serial, capture time) ever reaches the database and
   * Document AI receives exactly the downscaled JPEG the ledger keeps.
   *
   * The whole action is one request transaction, which is what makes a half-done
   * scan impossible: if extraction fails, the `Receipts` row inserted a moment
   * earlier is rolled back with everything else and the ledger is left exactly as
   * it was. See the rejection in the catch below for why nothing is marked
   * `failed` on the way out.
   */
  private async onScanReceipt(req: Request): Promise<DraftExpense> {
    const data = req.data as Record<string, unknown>
    const mediaType = typeof data.mediaType === 'string' ? data.mediaType.trim() : ''
    const fileName =
      typeof data.fileName === 'string' && data.fileName !== '' ? data.fileName : 'receipt.jpg'
    const uploaded = this.requireImageBytes(
      req,
      data.image,
      'scanReceipt needs the receipt image in the "image" parameter.',
    )
    // Asked for by name rather than guessed: `processReceiptImage` would report a
    // missing type as the sentence " is not an image", which tells a caller who
    // simply forgot the parameter nothing at all about what to do next.
    if (mediaType === '') {
      req.reject(400, 'scanReceipt needs the media type of the image in the "mediaType" parameter.')
    }

    let processed
    try {
      processed = await processReceiptImage(uploaded, mediaType)
    } catch (error) {
      if (error instanceof ImageError) req.reject(400, error.message)
      return req.reject(400, `the uploaded image could not be read: ${describeError(error)}`)
    }

    const receiptID = cds.utils.uuid()
    await INSERT.into(RECEIPTS).entries({
      ID: receiptID,
      image: processed.buffer,
      mediaType: 'image/jpeg',
      fileName,
      extractionStatus: 'pending',
    })

    const client = getDocAiClient()
    let job: unknown
    try {
      const jobId = await client.submitJob(processed.buffer, 'image/jpeg', fileName)
      job = await client.pollJob(jobId)
      await UPDATE.entity(RECEIPTS)
        .set({
          docaiJobId: jobId,
          extraction: JSON.stringify(job),
          // Only fixtures are 'mock'. An LLM reading the photograph really did read it,
          // and marking that 'mock' would tell the UI to disclaim a genuine extraction.
          extractionStatus: client.mode === 'mock' ? 'mock' : 'done',
        })
        .where({ ID: receiptID })
    } catch (error) {
      // Nothing is stamped `failed` here, and that is a decision rather than an
      // omission. `req.reject` rolls the request transaction back, receipt row
      // included, so a status written on a row that is about to disappear would
      // be a comforting lie: it would never be readable by anybody. A failed scan
      // leaves the ledger untouched and tells the caller why — the photo is still
      // on the phone that took it, and the upload can simply be repeated.
      const engine = client.mode === 'llm' ? 'Claude' : 'Document AI'
      return req.reject(502, `${engine} could not read this receipt: ${describeError(error)}`)
    }

    const extracted: ExtractedReceipt = mapJobResult(job)
    const merchantRaw = extracted.merchantRaw ?? ''
    const result =
      merchantRaw === ''
        ? null
        : await runClassifier(
            merchantRaw,
            extracted.amount ?? 0,
            whenISO(extracted.date, extracted.time),
          )

    const expenseID = cds.utils.uuid()
    await INSERT.into(EXPENSES).entries({
      ID: expenseID,
      date: extracted.date,
      time: extracted.time === null ? null : `${extracted.time}:00`,
      merchantRaw: extracted.merchantRaw,
      merchantNorm: merchantRaw === '' ? null : normaliseMerchant(merchantRaw),
      amount: extracted.amount,
      currency: extracted.currency,
      category_code: result?.category ?? null,
      categoryConfidence: result?.categoryConfidence ?? null,
      moment: (result?.moment as MomentCode | undefined) ?? null,
      momentConfidence: result?.momentConfidence ?? null,
      place: extracted.place,
      status: DRAFT,
      source: 'scan',
      receipt_ID: receiptID,
    })

    const draft = (await SELECT.one.from(EXPENSES).where({ ID: expenseID })) as DraftExpense
    // Every score the pipeline produced — extraction *and* both classifier heads
    // — has to clear the bar, and a receipt with no total or no date always
    // needs a human whatever the model thought of the merchant.
    const scores = [
      ...Object.values(extracted.confidence),
      ...(result === null ? [] : [result.categoryConfidence, result.momentConfidence]),
    ]
    draft.needsReview =
      extracted.amount === null ||
      extracted.date === null ||
      result === null ||
      scores.some(score => score < NEEDS_REVIEW_THRESHOLD)
    return draft
  }

  /**
   * The yearly "Statement of Us".
   *
   * `lib/statement` owns both halves of this: it aggregates the year and it asks
   * the provider selected by CONTRACTS §7 to write it, falling back to the
   * deterministic template renderer so the feature works with no credentials at
   * all. Regenerating a year overwrites it in place rather than piling up rows.
   */
  /**
   * Look at a face, estimate the mood, store nothing.
   *
   * The deliberate asymmetry with every other image action in this file: `addEventPhoto`
   * and `scanReceipt` both end in an INSERT, and this one must not. The photograph is
   * normalised, sent to the model (`srv/lib/mood.ts`), and released — saving the *reading*
   * is the caller's separate POST to `Moods`, which carries four small fields and no image.
   * Grep this handler for `INSERT` before believing anyone who says otherwise.
   *
   * Without an LLM key this is a 501 with a sentence, not a stub answer: a made-up mood
   * "reading" would be the same silent fabrication the receipt scanner was just cured of.
   */
  private async onDetectMood(req: Request): Promise<{
    level: number
    label: string
    confidence: number
    observation: string
  }> {
    if (!moodDetectionConfigured()) {
      return req.reject(
        501,
        'Mood detection needs an LLM key (set ANTHROPIC_API_KEY). The manual picker works without one.',
      )
    }

    const data = req.data as Record<string, unknown>
    const mediaType = typeof data.mediaType === 'string' ? data.mediaType.trim() : ''
    const uploaded = this.requireImageBytes(
      req,
      data.image,
      'detectMood needs the photograph in the "image" parameter.',
    )
    if (mediaType === '') {
      req.reject(400, 'detectMood needs the media type of the image in the "mediaType" parameter.')
    }

    // The same normalisation the receipts get: EXIF-rotated, bounded to 2000px, JPEG. A
    // phone selfie arrives at 10 MB and the model needs none of that.
    let processed
    try {
      processed = await processReceiptImage(uploaded, mediaType)
    } catch (error) {
      if (error instanceof ImageError) req.reject(400, error.message)
      return req.reject(400, `the uploaded image could not be read: ${describeError(error)}`)
    }

    // `req.reject` throws, so the "no face" answer has to be decided *outside* the try
    // below — inside it, the 422 would be caught and re-issued as a 502 about the model.
    let reading
    try {
      reading = await detectMood(processed.buffer, 'image/jpeg')
    } catch (error) {
      return req.reject(502, `Could not read a mood from that photograph: ${describeError(error)}`)
    }
    if (!reading.faceFound) {
      return req.reject(422, 'No face was discernible in that photograph — try better light.')
    }
    return {
      level: reading.level,
      label: reading.label,
      confidence: reading.confidence,
      observation: reading.observation,
    }
  }

  private async onGenerateStatement(req: Request): Promise<Statement> {
    const raw = (req.data as Record<string, unknown>).year
    const year = Number(raw)
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      req.reject(400, `year must be a four-digit calendar year, got ${JSON.stringify(raw)}.`)
    }

    let markdown: string
    let engine: string
    try {
      const generated = await writeStatement(await aggregateYear(year, await this.readable(req)))
      markdown = generated.markdown
      engine = generated.engine
    } catch (error) {
      return req.reject(
        502,
        `the statement for ${year} could not be written: ${describeError(error)}`,
      )
    }

    const generatedAt = new Date().toISOString()
    const existing = (await SELECT.one
      .from(STATEMENTS)
      .columns('ID')
      .where({ year })) as Statement | null
    const ID = existing?.ID ?? cds.utils.uuid()
    if (existing?.ID) {
      await UPDATE.entity(STATEMENTS)
        .set({ contentMarkdown: markdown, generatedAt, engine })
        .where({ ID })
    } else {
      await INSERT.into(STATEMENTS).entries({
        ID,
        year,
        contentMarkdown: markdown,
        generatedAt,
        engine,
      })
    }
    return (await SELECT.one.from(STATEMENTS).where({ ID })) as Statement
  }

  /* ================================= photos, reminders, surprises (§11) */

  /**
   * A photograph, attached to an event.
   *
   * Same pipeline as `scanReceipt`, deliberately and literally: the bytes go
   * through `processReceiptImage` before anything is stored, so no EXIF — no
   * GPS, no device serial, no capture time — survives, the long edge is capped
   * at 2000 px and the result is JPEG q85. A photo of a trip does not need a
   * second image pipeline, and a second one would be a second place for the
   * metadata strip to be forgotten.
   *
   * `takenOn` is the only piece of that metadata that comes back, and it comes
   * back because a human typed it.
   */
  private async onAddEventPhoto(req: Request): Promise<EventPhoto> {
    const data = req.data as Record<string, unknown>
    const event = await this.requireVisibleEvent(req, data.eventId, 'addEventPhoto', 'eventId')

    const mediaType = typeof data.mediaType === 'string' ? data.mediaType.trim() : ''
    const uploaded = this.requireImageBytes(
      req,
      data.image,
      'addEventPhoto needs the photograph in the "image" parameter.',
    )
    // Asked for by name rather than guessed: `processReceiptImage` would report
    // a missing type as the sentence " is not an image", which tells a caller
    // who simply forgot the parameter nothing at all about what to do next.
    if (mediaType === '') {
      req.reject(400, 'addEventPhoto needs the media type of the photograph in "mediaType".')
    }

    const caption = textOf(data.caption)
    if (caption !== null && caption.length > MAX_TEXT_LENGTH) {
      req.reject(
        400,
        `a caption is at most ${MAX_TEXT_LENGTH} characters; this one is ${caption.length}.`,
      )
    }
    // No shape check: `takenOn` is declared `Date` in the service, and CAP
    // refuses a malformed one with ASSERT_DATA_TYPE before this handler runs.
    // `dateOf` only trims a timestamp back to its day. `fromDate`/`toDate` on
    // `upcoming` are declared `String` and are checked, in `requireDate`.
    const takenOn = dateOf(data.takenOn)

    let processed
    try {
      processed = await processReceiptImage(uploaded, mediaType)
    } catch (error) {
      if (error instanceof ImageError) req.reject(400, error.message)
      return req.reject(400, `the uploaded photograph could not be read: ${describeError(error)}`)
    }

    const ID = cds.utils.uuid()
    await INSERT.into(EVENT_PHOTOS).entries({
      ID,
      event_ID: String(event.ID),
      image: processed.buffer,
      mediaType: 'image/jpeg',
      caption,
      takenOn,
    })
    return await this.readPhoto(ID)
  }

  /**
   * One photograph, gone.
   *
   * Only the picture: the event, its other photos, its reminders and every
   * posting on it are untouched. A photo that cannot be seen cannot be deleted
   * either, which is why this goes through the same visibility check as
   * everything else on an event.
   */
  private async onDeleteEventPhoto(req: Request): Promise<void> {
    const id = String((req.data as Record<string, unknown>).ID ?? '')
    if (id === '') req.reject(400, 'deleteEventPhoto needs the ID of the photograph to remove.')

    const photo = (await SELECT.one
      .from(EVENT_PHOTOS)
      .columns('ID', 'event_ID')
      .where({ ID: id })) as EventPhoto | null
    if (!photo) req.reject(404, `there is no photograph with ID ${id}.`)
    await this.requireVisibleEvent(req, photo.event_ID, 'deleteEventPhoto', 'event_ID')

    await DELETE.from(EVENT_PHOTOS).where({ ID: id })
  }

  /**
   * Let the surprise out (CONTRACTS §11.3).
   *
   * Stamping `revealedAt` is all it takes: from that moment the event is an
   * ordinary one for everybody, and the four columns {@link isSecret} reads
   * agree. A surprise whose `startsOn` has already arrived is visible to
   * everybody anyway, but revealing it is still allowed and still stamps —
   * "it happened" and "I told you" are two different facts, and the badge in the
   * UI reads off this one.
   */
  private async onRevealSurprise(req: Request): Promise<Event> {
    const id = String((req.data as Record<string, unknown>).ID ?? '')
    if (id === '') req.reject(400, 'revealSurprise needs the ID of the surprise to reveal.')
    const event = await this.requireVisibleEvent(req, id, 'revealSurprise', 'ID')

    if (event.isSurprise !== true) {
      req.reject(
        400,
        `${event.name ?? 'that event'} is not a surprise; there is nothing to reveal.`,
      )
    }
    if (isSet(event.revealedAt)) {
      req.reject(400, `${event.name ?? 'that event'} has already been revealed.`)
    }

    await UPDATE.entity(EVENTS).set({ revealedAt: new Date().toISOString() }).where({ ID: id })
    return (await SELECT.one.from(EVENTS).where({ ID: id })) as Event
  }

  /**
   * A nudge, `leadDays` before an event starts.
   *
   * `dueOn` is not stored — it is `startsOn - leadDays`, computed by `addDays`
   * from `lib/dates` wherever it is needed (see {@link onUpcoming}). A stored
   * copy would be wrong the first time somebody moved the event, and moving an
   * event is the most ordinary thing in the world.
   */
  private async onCreateReminder(req: Request): Promise<Reminder> {
    const data = req.data as Record<string, unknown>
    const event = await this.requireVisibleEvent(req, data.eventId, 'createReminder', 'eventId')

    const leadDays = this.requireLeadDays(req, data.leadDays)
    const note = textOf(data.note)
    if (note !== null && note.length > MAX_TEXT_LENGTH) {
      req.reject(
        400,
        `a reminder note is at most ${MAX_TEXT_LENGTH} characters; this one is ${note.length}.`,
      )
    }

    const ID = cds.utils.uuid()
    await INSERT.into(REMINDERS).entries({
      ID,
      event_ID: String(event.ID),
      leadDays,
      note,
      done: false,
    })
    return (await SELECT.one.from(REMINDERS).where({ ID })) as Reminder
  }

  /**
   * Ticks a reminder off.
   *
   * Deliberately idempotent, unlike {@link onMarkSettled}: closing a period
   * twice would mean two clearing documents for one month, but ticking a
   * reminder twice writes the same `true` over the same `true`. A second tap on
   * a slow phone is not an error worth a red banner.
   */
  private async onCompleteReminder(req: Request): Promise<Reminder> {
    const id = String((req.data as Record<string, unknown>).ID ?? '')
    if (id === '') req.reject(400, 'completeReminder needs the ID of the reminder to tick off.')

    const reminder = (await SELECT.one
      .from(REMINDERS)
      .columns('ID', 'event_ID')
      .where({ ID: id })) as Reminder | null
    if (!reminder) req.reject(404, `there is no reminder with ID ${id}.`)
    await this.requireVisibleEvent(req, reminder.event_ID, 'completeReminder', 'event_ID')

    await UPDATE.entity(REMINDERS).set({ done: true }).where({ ID: id })
    return (await SELECT.one.from(REMINDERS).where({ ID: id })) as Reminder
  }

  /**
   * The whole calendar window in one answer.
   *
   * A month grid needs, for every day it shows, the events that cover it and the
   * reminders that fall due on it. Asked per day that is thirty-one round trips
   * for a screen a thumb flicks through; asked once it is two reads and a sort.
   *
   * The two rules that make this more than a join:
   *
   * - **Events span days.** An entry is kept when the event overlaps the window
   *   at all, not only when it starts inside it, so the second week of a trip
   *   that began in the previous month is still on the grid. `date` is always
   *   the first day and `endsOn` the last, and the grid spreads it.
   * - **The answer depends on who is asking.** A hidden surprise is missing
   *   entirely for everybody but its creator, and carries `onlyYou` for them —
   *   which is what the discreet badge in §11.3 rule 3 reads. A reminder on a
   *   hidden surprise is hidden with it: "book the thing, 14 days before the
   *   thing" on an otherwise empty calendar is not much of a secret.
   */
  private async onUpcoming(req: Request): Promise<CalendarEntry[]> {
    const data = req.data as Record<string, unknown>
    const fromDate = this.requireDate(req, data.fromDate, 'fromDate')
    const toDate = this.requireDate(req, data.toDate, 'toDate')
    if (fromDate > toDate) {
      req.reject(400, `fromDate ${fromDate} is after toDate ${toDate}.`)
    }

    const today = todayISO()
    const me = await this.viewer(req)
    const viewerId = me?.ID ?? null
    // Every event, then windowed in TypeScript. "Overlaps the window" is
    // `(endsOn ?? startsOn) >= fromDate and startsOn <= toDate` — expressible in
    // SQL, but only with a COALESCE that would then have to agree with the same
    // rule written out below for the reminders. A household's events fit in one
    // read; two spellings of one rule do not stay in step.
    const events = (await SELECT.from(EVENTS).columns(...CALENDAR_COLUMNS)) as Event[]

    const visible = new Map<string, Event>()
    for (const event of events) {
      if (isHiddenFrom(event, viewerId, today)) continue
      visible.set(String(event.ID), event)
    }

    const entries: CalendarEntry[] = []
    for (const [eventId, event] of visible) {
      const startsOn = dateOf(event.startsOn)
      if (startsOn === null) continue
      const endsOn = dateOf(event.endsOn)
      const lastDay = endsOn !== null && endsOn > startsOn ? endsOn : startsOn
      if (lastDay < fromDate || startsOn > toDate) continue

      entries.push({
        ID: eventId,
        kind: 'event',
        date: startsOn,
        endsOn,
        title: event.name ?? '',
        place: event.place ?? null,
        eventId,
        onlyYou: isSecret(event, today),
        leadDays: null,
        done: null,
      })
    }

    const reminders = (await SELECT.from(REMINDERS).columns(
      'ID',
      'event_ID',
      'leadDays',
      'note',
      'done',
    )) as Reminder[]
    for (const reminder of reminders) {
      const event = visible.get(String(reminder.event_ID ?? ''))
      if (event === undefined) continue
      const startsOn = dateOf(event.startsOn)
      if (startsOn === null) continue

      const leadDays = Number.isInteger(reminder.leadDays)
        ? Number(reminder.leadDays)
        : DEFAULT_LEAD_DAYS
      const dueOn = addDays(startsOn, -leadDays)
      if (dueOn < fromDate || dueOn > toDate) continue

      entries.push({
        ID: String(reminder.ID),
        kind: 'reminder',
        date: dueOn,
        endsOn: null,
        // A reminder with no note of its own is about the event, and says so.
        title: textOf(reminder.note) ?? event.name ?? '',
        place: event.place ?? null,
        eventId: String(event.ID),
        onlyYou: isSecret(event, today),
        leadDays,
        done: reminder.done === true,
      })
    }

    return entries.sort(byCalendarOrder)
  }

  /* =============================================================== helpers */

  /**
   * The rows `lib/settlement` adds up, paired with the IDs they came from so the
   * period close can link them afterwards.
   *
   * Only confirmed postings count: a draft is an unposted receipt, and a total
   * that moved every time somebody photographed something would not be a total.
   */
  private async totalsLines(opts: {
    period?: string
    eventId?: string
    unclosedOnly?: boolean
  }): Promise<TotalsLine[]> {
    const where: Record<string, unknown> = { status: CONFIRMED }
    if (opts.unclosedOnly === true) where.settlement_ID = null
    if (opts.eventId !== undefined) where.event_ID = opts.eventId

    const rows = (await SELECT.from(EXPENSES)
      .columns('ID', 'amount', 'paidBy_ID', 'event_ID', 'date', 'documentNumber')
      .where(where)) as Expense[]

    const lines: TotalsLine[] = []
    for (const row of rows) {
      const amount = amountOf(row.amount)
      // A row with no amount or no date cannot be added up or windowed, so it is
      // left out. A row with no *payer* is not: the money was spent, so it
      // belongs in the total, and `lib/settlement` files it under an id that
      // matches nobody on the roster rather than against the wrong person. That
      // also keeps `periodTotals` agreeing with `monthlyTotals`, which counts
      // every confirmed posting whoever paid for it.
      if (amount === null || typeof row.date !== 'string') continue
      if (opts.period !== undefined && periodOf(row.date) !== opts.period) continue

      lines.push({
        ID: String(row.ID),
        documentNumber: row.documentNumber ?? null,
        input: {
          amount,
          paidById: row.paidBy_ID ?? '',
          eventId: row.event_ID ?? null,
          date: row.date,
        },
      })
    }
    return lines
  }

  /**
   * The database, as `aggregateYear` should see it (CONTRACTS §11.3 rule 1).
   *
   * The yearly statement names the events of the year, and a hidden surprise
   * must not be one of them. `srv/lib/statement.ts` takes an optional db handle
   * precisely so a caller can decide what it reads, so the filter goes here
   * rather than into the aggregation: nothing about a statement's arithmetic
   * changes, one of its five queries simply comes back a row shorter.
   *
   * And only that query. The expense rows it reads are the same rows they always
   * were — a hidden surprise's spending is in the year's total, in its quarters
   * and in its per-person figures, exactly like any other posting. The event
   * loses its name in the prose; the money never moves.
   *
   * `undefined` when nothing is hidden, which is the normal case: `aggregateYear`
   * then resolves the ambient `cds.db` itself and this costs nothing.
   */
  private async readable(req: Request): Promise<RunnableDb | undefined> {
    const hidden = new Set(await this.hiddenSurpriseIds(req))
    if (hidden.size === 0) return undefined

    const db = cds.db as unknown as RunnableDb
    return {
      async run(query: unknown): Promise<unknown> {
        const rows: unknown = await db.run(query)
        if (!readsEventsTable(query) || !Array.isArray(rows)) return rows
        return rows.filter(row => !(isRecord(row) && hidden.has(String(row.ID))))
      },
    }
  }

  /** Everybody in the ledger, in no significant order — the totals library sorts. */
  private async roster(): Promise<RosterEntry[]> {
    const people = (await SELECT.from(PEOPLE).columns('ID', 'name')) as Person[]
    return people.map(person => ({ ID: String(person.ID), name: person.name ?? '' }))
  }

  /** The people on one event, read through its link table. */
  private async participantsOf(eventId: string): Promise<RosterEntry[]> {
    const links = (await SELECT.from(EVENT_PARTICIPANTS)
      .columns('person_ID')
      .where({ event_ID: eventId })) as EventParticipant[]
    const ids = links.map(link => String(link.person_ID))
    if (ids.length === 0) return []

    const people = (await SELECT.from(PEOPLE)
      .columns('ID', 'name')
      .where({ ID: { in: ids } })) as Person[]
    return people.map(person => ({ ID: String(person.ID), name: person.name ?? '' }))
  }

  /** `YYYY-MM`, or a 400 that says which argument was wrong and why. */
  private requirePeriod(req: Request, value: unknown, name: string): string {
    const period = typeof value === 'string' ? value.trim() : ''
    if (!PERIOD_PATTERN.test(period)) {
      req.reject(400, `${name} must be a period of the form YYYY-MM, got ${JSON.stringify(value)}.`)
    }
    return period
  }

  /** `YYYY-MM-DD`, likewise. A `Date` parameter arrives as one over OData. */
  private requireDate(req: Request, value: unknown, name: string): string {
    const date = typeof value === 'string' ? value.trim().slice(0, 10) : ''
    if (!DATE_PATTERN.test(date)) {
      req.reject(
        400,
        `${name} must be a date of the form YYYY-MM-DD, got ${JSON.stringify(value)}.`,
      )
    }
    return date
  }

  /**
   * How many days of notice a reminder gives.
   *
   * Absent means {@link DEFAULT_LEAD_DAYS} — CONTRACTS §11.2's own default, so a
   * caller that only knows which event it cares about still gets a working
   * reminder. Everything else has to be a whole number of days between zero
   * ("on the day") and a year; a negative lead would fire *after* the event, and
   * a fractional one is not a thing a calendar can show.
   */
  private requireLeadDays(req: Request, value: unknown): number {
    if (value === null || value === undefined || value === '') return DEFAULT_LEAD_DAYS
    const leadDays = Number(value)
    if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > MAX_LEAD_DAYS) {
      req.reject(
        400,
        `leadDays must be a whole number of days between 0 and ${MAX_LEAD_DAYS}, ` +
          `got ${JSON.stringify(value)}.`,
      )
    }
    return leadDays
  }

  /**
   * Which `People` row is asking.
   *
   * CONTRACTS §11.3: identity in dev comes from CAP's mocked user, which knows a
   * login name and nothing about this ledger's roster. So the name is matched
   * against `People.name`, then against `People.email` for a deployment where
   * the identity provider hands over an address — and when neither matches,
   * the first person marked `isDefault` answers for the household.
   *
   * **This never throws and never rejects.** A missed mapping is the normal case
   * on a laptop with `auth: mocked`, and an app that refused to show a calendar
   * because "alice" is not in `People` would be broken for its only two users.
   * The cost of the fallback is bounded: the worst it can do is show a surprise
   * to the wrong half of a two-person household, which is the same risk that
   * household already takes by leaving the laptop unlocked. `null` comes back
   * only when there is nobody at all in the ledger, and
   * {@link isHiddenFrom} then fails closed.
   */
  private async viewer(req: Request): Promise<RosterEntry | null> {
    const people = (await SELECT.from(PEOPLE).columns(
      'ID',
      'name',
      'email',
      'isDefault',
    )) as Person[]
    if (people.length === 0) return null

    // Sorted rather than left to the database, so "the first isDefault person"
    // means the same thing on every run and on every driver.
    const roster = [...people].sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '') || String(a.ID).localeCompare(String(b.ID)),
    )
    const claimed = claimedIdentity(req)
    const matched =
      claimed === ''
        ? undefined
        : (roster.find(person => (person.name ?? '').toLowerCase() === claimed) ??
          roster.find(person => (person.email ?? '').toLowerCase() === claimed))
    const person = matched ?? roster.find(entry => entry.isDefault === true) ?? roster[0]
    return { ID: String(person.ID), name: person.name ?? '' }
  }

  /**
   * The events this viewer may not know about.
   *
   * Cheap in the normal case: one indexed read that returns nothing, and the
   * roster is not even loaded. Only when an unrevealed surprise exists does this
   * cost a second query.
   */
  private async hiddenSurpriseIds(req: Request): Promise<string[]> {
    const secrets = (await SELECT.from(EVENTS)
      .columns(...SURPRISE_COLUMNS)
      .where({ isSurprise: true, revealedAt: null })) as Event[]
    if (secrets.length === 0) return []

    const me = await this.viewer(req)
    const viewerId = me?.ID ?? null
    const today = todayISO()
    return secrets
      .filter(event => isHiddenFrom(event, viewerId, today))
      .map(event => String(event.ID))
  }

  /**
   * The event behind an id, as the caller is allowed to see it.
   *
   * A hidden surprise gets exactly the same 404 as an id that names nothing.
   * "That event exists, but it is not for your eyes" would give away the one
   * thing §11.3 exists to keep quiet — and a 403 on a well-guessed id is a
   * perfectly good way to find out what somebody is planning.
   */
  private async requireVisibleEvent(
    req: Request,
    value: unknown,
    action: string,
    parameter: string,
  ): Promise<Event> {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id === '') req.reject(400, `${action} needs the ID of the event in "${parameter}".`)

    const event = (await SELECT.one
      .from(EVENTS)
      .columns(...CALENDAR_COLUMNS)
      .where({ ID: id })) as Event | null
    if (!event) req.reject(404, `there is no event with ID ${id}.`)

    if (isSecret(event, todayISO())) {
      const me = await this.viewer(req)
      if (isHiddenFrom(event, me?.ID ?? null, todayISO())) {
        req.reject(404, `there is no event with ID ${id}.`)
      }
    }
    return event
  }

  /**
   * One photo row, without its bytes.
   *
   * The columns are listed rather than starred on purpose: `image` is a
   * `@Core.MediaType` `LargeBinary`, and reading it back would drag the whole
   * JPEG through the action's JSON response for no reason. The picture itself is
   * served as a media stream from `EventPhotos(<id>)/image`.
   */
  private async readPhoto(ID: string): Promise<EventPhoto> {
    return (await SELECT.one
      .from(EVENT_PHOTOS)
      .columns('ID', 'event_ID', 'mediaType', 'caption', 'takenOn', 'createdAt')
      .where({ ID })) as EventPhoto
  }

  /**
   * The uploaded bytes.
   *
   * OData sends a `LargeBinary` action parameter base64-encoded, while an
   * in-process caller passes a `Buffer` straight through; both are accepted so
   * that one handler serves the PWA, a script and the tests alike.
   */
  private requireImageBytes(req: Request, value: unknown, missing: string): Buffer {
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value === 'string' && value !== '') return Buffer.from(value, 'base64')
    if (isRecord(value) && value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data as number[])
    }
    return req.reject(400, missing)
  }
}
