/**
 * The OData client — FRONTEND-CONTRACT §3.
 *
 * Everything the pages know about the backend goes through `api`. Five pieces of OData
 * awkwardness are hidden in here and must not leak upwards:
 *
 *  - **Decimals arrive as strings.** `Decimal(10,2)` and `Decimal(5,4)` are serialised as
 *    JSON strings by OData V4 to preserve scale (`"148.50"`, `"0.9871"`). Every mapper
 *    below runs money and confidence through `num` / `numOrNull`, so a page never has to
 *    wonder whether `amount` is a string today.
 *  - **Collections are enveloped.** Entity sets and collection-returning functions answer
 *    `{ "@odata.context": …, "value": [...] }`; `unwrap` strips that.
 *  - **Functions and actions differ.** Functions are `GET /api/ledger/name(arg='value')` with
 *    their arguments inline and string literals single-quoted; actions are
 *    `POST /api/ledger/name` with a JSON body. `Edm.Guid` literals are bare in OData V4 —
 *    `duplicates(ID=e0000000-…)`, not `duplicates(ID='e0000000-…')`.
 *  - **An event's roster is two joins away.** `Events.participants` is a composition of link
 *    rows, so reads expand `participants($expand=person)` and writes send
 *    `participants: [{ person_ID }]`. Pages hand over and receive plain `Person[]`.
 *  - **A reminder's due day is not stored.** `dueOn` is `startsOn - leadDays`, and a column
 *    would go stale the moment an event moved, so `Reminders` reads expand their event and
 *    the subtraction happens here — once, rather than in every page that lists one.
 *
 * Errors always surface as `ApiError` carrying the CAP `{ error: { message } }` text, which
 * is written for humans (`"period 2026-01 has already been closed by CLR-2026-01."`) and is
 * therefore safe to show in `ErrorState` verbatim.
 */

import type {
  CalendarEntry,
  Category,
  Event,
  EventPatch,
  EventPhoto,
  EventTotals,
  Expense,
  ExpenseQuery,
  Health,
  Memory,
  MonthlyTotal,
  NewEvent,
  NewEventPhoto,
  NewReminder,
  PeriodTotals,
  Person,
  PersonTotal,
  Photo,
  Reminder,
  ScanResult,
  ScoredLabel,
  Settlement,
  Statement,
  Mood,
  MoodSuggestion,
} from './types'

/** OData service root. Vite proxies this to the CAP server on :4004 in dev. */
const BASE = '/api/ledger'

/** The probe lives outside the OData router — see `srv/server.ts`. */
const HEALTH_PATH = '/health'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const PERIOD_RE = /^\d{4}-\d{2}$/

/** Reads an event's roster in one round trip; used by every Events read. */
const PARTICIPANT_EXPAND = 'participants($expand=person)'

/**
 * Pictures are detail data: expanded on `getEvent`, never on the list. Shaped exactly like
 * the Memories expand that already works — metadata only, the bytes stay behind their
 * media stream so a ten-photo trip does not arrive as a megabyte of base64.
 */
const PHOTO_EXPAND = 'photos($select=ID,mediaType,caption,takenOn)'

/** A reminder is useless without the event behind it — one expand, no second read. */
const REMINDER_EXPAND = 'event($select=ID,name,startsOn)'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A failed call to the ledger. `message` is CAP's own `error.message`; `detail` carries the
 * machine-readable bits (`code`, `target`) or the raw body when the response was not JSON.
 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, message: string, detail = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    // Keeps `instanceof ApiError` working when the class is down-levelled.
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}

/** Narrowing helper so components can branch without importing the class shape. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** The one place that turns an unknown thrown value into something worth showing a human. */
export function describeError(error: unknown): string {
  if (isApiError(error)) return error.message
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Something went wrong.'
}

/* ------------------------------------------------------------------ *
 *  Transport
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const hasBody = options.body !== undefined

  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: hasBody
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { Accept: 'application/json' },
      body: hasBody ? JSON.stringify(options.body) : undefined,
    })
  } catch (cause) {
    // Offline, DNS, or the CAP server is not up yet. Status 0 says "never reached it".
    throw new ApiError(0, 'The ledger could not be reached. Check the connection.', String(cause))
  }

  if (!response.ok) throw await toApiError(response)
  if (response.status === 204) return undefined as unknown as T

  const text = await response.text()
  if (!text) return undefined as unknown as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(
      response.status,
      'The ledger sent a response that is not JSON.',
      text.slice(0, 200),
    )
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const raw = await response.text().catch(() => '')
  let message = ''
  let detail = ''

  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown; code?: unknown; target?: unknown }
    }
    const envelope = parsed.error
    if (envelope) {
      if (typeof envelope.message === 'string') message = envelope.message
      const parts = [envelope.code, envelope.target].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      )
      detail = parts.join(' · ')
    }
  } catch {
    // Not the OData envelope — `srv/server.ts` answers 401 before CAP's routers, and a
    // proxy in front of the app may answer HTML. Keep the body as the detail; never put a
    // page of markup in front of a human as though it were a sentence.
    detail = raw.slice(0, 200)
  }

  if (!message) {
    message =
      `${response.status} ${response.statusText}`.trim() || 'The ledger refused the request.'
  }
  return new ApiError(response.status, message, detail)
}

/* ------------------------------------------------------------------ *
 *  OData URL construction
 * ------------------------------------------------------------------ */

/** Escapes a value for an OData single-quoted string literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `Edm.Guid` literals are bare in V4; anything that is not a UUID falls back to a string. */
function guidLiteral(value: string): string {
  return UUID_RE.test(value) ? value : literal(value)
}

/** `Expenses(<uuid>)` — the entity key segment. */
function keySegment(id: string): string {
  return `(${encodeURIComponent(guidLiteral(id))})`
}

function withQuery(path: string, params: Array<[string, string]>): string {
  if (params.length === 0) return path
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  return `${path}?${query}`
}

/** First and last calendar day of a 'YYYY-MM' period, as `Edm.Date` literals. */
function periodRange(period: string): [string, string] {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return [`${period}-01`, `${period}-${String(lastDay).padStart(2, '0')}`]
}

/**
 * `startsOn - leadDays`, in UTC so a summer-time boundary cannot shift the day.
 * Only ever used to fill in a `Reminder.dueOn` the service did not send.
 */
function shiftIsoDate(iso: string, days: number): string | null {
  if (!ISO_DATE_RE.test(iso)) return null
  const at = Date.parse(`${iso}T00:00:00Z`)
  if (Number.isNaN(at)) return null
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10)
}

/* ------------------------------------------------------------------ *
 *  Coercion — the wire is stringly typed, the app is not
 * ------------------------------------------------------------------ */

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1
}

function unwrap(payload: unknown): Row[] {
  if (payload && typeof payload === 'object') {
    const value = (payload as { value?: unknown }).value
    if (Array.isArray(value)) return value as Row[]
  }
  return []
}

function asRow(payload: unknown): Row {
  return payload && typeof payload === 'object' ? (payload as Row) : {}
}

function scored(value: unknown): ScoredLabel[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(entry => {
    const row = asRow(entry)
    return { label: str(row.label), p: num(row.p) }
  })
}

/* ------------------------------------------------------------------ *
 *  Mappers
 * ------------------------------------------------------------------ */

function toExpense(payload: unknown): Expense {
  const row = asRow(payload)
  return {
    ID: str(row.ID),
    date: str(row.date),
    time: strOrNull(row.time),
    merchantRaw: str(row.merchantRaw),
    merchantNorm: strOrNull(row.merchantNorm),
    amount: num(row.amount),
    currency: str(row.currency, 'CHF'),
    category_code: strOrNull(row.category_code),
    categoryConfidence: numOrNull(row.categoryConfidence),
    moment: (strOrNull(row.moment) as Expense['moment']) ?? null,
    momentConfidence: numOrNull(row.momentConfidence),
    paidBy_ID: strOrNull(row.paidBy_ID),
    event_ID: strOrNull(row.event_ID),
    status: (strOrNull(row.status) as Expense['status']) ?? 'draft',
    source: (strOrNull(row.source) as Expense['source']) ?? 'manual',
    note: strOrNull(row.note),
    place: strOrNull(row.place),
    lat: numOrNull(row.lat),
    lon: numOrNull(row.lon),
    receipt_ID: strOrNull(row.receipt_ID),
    documentNumber: numOrNull(row.documentNumber),
    settlement_ID: strOrNull(row.settlement_ID),
  }
}

function toScanResult(payload: unknown): ScanResult {
  const row = asRow(payload)
  const result: ScanResult = { ...toExpense(row), needsReview: bool(row.needsReview) }
  const categoryTop3 = scored(row.categoryTop3)
  const momentTop3 = scored(row.momentTop3)
  if (categoryTop3) result.categoryTop3 = categoryTop3
  if (momentTop3) result.momentTop3 = momentTop3
  return result
}

function toCategory(payload: unknown): Category {
  const row = asRow(payload)
  return {
    code: str(row.code),
    name: str(row.name) || str(row.code),
    icon: str(row.icon),
    colour: str(row.colour),
    sortOrder: num(row.sortOrder),
  }
}

function toPerson(payload: unknown): Person {
  const row = asRow(payload)
  const person: Person = {
    ID: str(row.ID),
    name: str(row.name),
    colour: str(row.colour),
    isDefault: bool(row.isDefault),
  }
  const email = strOrNull(row.email)
  if (email) person.email = email
  return person
}

/**
 * `participants` comes back as link rows — `{ event_ID, person_ID, person: {…} }`. Only the
 * expanded `person` is of any use to a page, and a row that was not expanded is dropped
 * rather than turned into a nameless placeholder.
 */
function toParticipants(value: unknown): Person[] {
  if (!Array.isArray(value)) return []
  const people: Person[] = []
  for (const entry of value) {
    const row = asRow(entry)
    const nested = row.person
    const source = nested && typeof nested === 'object' ? asRow(nested) : row
    if (!str(source.ID)) continue
    people.push(toPerson(source))
  }
  return people
}

function toEventPhoto(payload: unknown): EventPhoto {
  const row = asRow(payload)
  return {
    ID: str(row.ID),
    event_ID: strOrNull(row.event_ID),
    mediaType: str(row.mediaType, 'image/jpeg'),
    caption: strOrNull(row.caption),
    takenOn: strOrNull(row.takenOn),
  }
}

function toEvent(payload: unknown): Event {
  const row = asRow(payload)
  const event: Event = {
    ID: str(row.ID),
    name: str(row.name),
    startsOn: str(row.startsOn),
    endsOn: strOrNull(row.endsOn),
    place: strOrNull(row.place),
    note: strOrNull(row.note),
    participants: toParticipants(row.participants),
    isSurprise: bool(row.isSurprise),
    createdBy_ID: strOrNull(row.createdBy_ID),
    revealedAt: strOrNull(row.revealedAt),
  }
  // Only present when the read asked for it; an absent expand is not an empty album.
  if (Array.isArray(row.photos)) event.photos = row.photos.map(toEventPhoto)
  return event
}

/**
 * `dueOn` is `startsOn - leadDays` (CONTRACTS §11.2). The service is free to compute it —
 * and if it does, that value wins — but a reminder read with its event expanded already
 * carries everything the subtraction needs, so a page is never left without a date.
 */
function toReminder(payload: unknown): Reminder {
  const row = asRow(payload)
  const event = row.event && typeof row.event === 'object' ? asRow(row.event) : {}
  const leadDays = num(row.leadDays)
  const eventStartsOn = strOrNull(event.startsOn)
  const sent = strOrNull(row.dueOn)
  return {
    ID: str(row.ID),
    event_ID: strOrNull(row.event_ID) ?? strOrNull(event.ID),
    leadDays,
    note: strOrNull(row.note),
    done: bool(row.done),
    dueOn: sent ?? (eventStartsOn ? shiftIsoDate(eventStartsOn, -leadDays) : null),
    eventName: strOrNull(event.name),
    eventStartsOn,
  }
}

function toCalendarEntry(payload: unknown): CalendarEntry {
  const row = asRow(payload)
  const kind = strOrNull(row.kind) === 'reminder' ? 'reminder' : 'event'
  return {
    ID: str(row.ID),
    kind,
    date: str(row.date),
    endsOn: strOrNull(row.endsOn),
    title: str(row.title),
    place: strOrNull(row.place),
    // An event row's `eventId` is its own key; the service sends it, this is the belt.
    eventId: strOrNull(row.eventId) ?? (kind === 'event' ? strOrNull(row.ID) : null),
    onlyYou: bool(row.onlyYou),
    // Both are meaningless on an event row, and null says so more plainly than 0/false.
    leadDays: kind === 'reminder' ? numOrNull(row.leadDays) : null,
    done: kind === 'reminder' ? bool(row.done) : null,
  }
}

function toPhoto(payload: unknown): Photo {
  const row = asRow(payload)
  return { ID: str(row.ID), mediaType: str(row.mediaType), caption: strOrNull(row.caption) }
}

function toMemory(payload: unknown): Memory {
  const row = asRow(payload)
  const memory: Memory = {
    ID: str(row.ID),
    expense_ID: strOrNull(row.expense_ID),
    title: str(row.title),
    note: strOrNull(row.note),
    occurredOn: str(row.occurredOn),
    kind: (strOrNull(row.kind) as Memory['kind']) ?? 'other',
    pinned: bool(row.pinned),
    place: strOrNull(row.place),
    lat: numOrNull(row.lat),
    lon: numOrNull(row.lon),
  }
  if (Array.isArray(row.photos)) memory.photos = row.photos.map(toPhoto)
  return memory
}

function toSettlement(payload: unknown): Settlement {
  const row = asRow(payload)
  return {
    ID: str(row.ID),
    period: str(row.period),
    grandTotal: num(row.grandTotal),
    status: strOrNull(row.status) === 'settled' ? 'settled' : 'open',
    settledAt: strOrNull(row.settledAt),
    clearingDocument: str(row.clearingDocument),
    approvedBy: str(row.approvedBy),
  }
}

function toStatement(payload: unknown): Statement {
  const row = asRow(payload)
  return {
    ID: str(row.ID),
    year: num(row.year),
    contentMarkdown: str(row.contentMarkdown),
    generatedAt: str(row.generatedAt),
    engine: str(row.engine),
  }
}

function toPersonTotals(value: unknown): PersonTotal[] {
  if (!Array.isArray(value)) return []
  return value.map(entry => {
    const row = asRow(entry)
    return {
      personId: str(row.personId),
      name: str(row.name),
      paid: num(row.paid),
      count: num(row.count),
      share: num(row.share),
    }
  })
}

function toPeriodTotals(payload: unknown): PeriodTotals {
  const row = asRow(payload)
  return {
    period: str(row.period),
    grandTotal: num(row.grandTotal),
    count: num(row.count),
    byPerson: toPersonTotals(row.byPerson),
  }
}

function toEventTotals(payload: unknown): EventTotals {
  const row = asRow(payload)
  return {
    eventId: str(row.eventId),
    name: str(row.name),
    grandTotal: num(row.grandTotal),
    perHead: num(row.perHead),
    participantCount: num(row.participantCount),
    count: num(row.count),
    byPerson: toPersonTotals(row.byPerson),
  }
}

function toMonthlyTotal(payload: unknown): MonthlyTotal {
  const row = asRow(payload)
  return { period: str(row.period), category: str(row.category), total: num(row.total) }
}

/* ------------------------------------------------------------------ *
 *  Serialisation for writes
 * ------------------------------------------------------------------ */

const EXPENSE_DECIMALS: Record<string, number> = {
  amount: 2,
  categoryConfidence: 4,
  momentConfidence: 4,
}

/**
 * CDS asserts `Decimal(10,2)` on the way in, so send money with its scale intact rather
 * than trusting `JSON.stringify(12.5)`. Undefined keys are dropped — a PATCH must only
 * carry the fields the caller actually meant to change — while an explicit `null` is kept,
 * because that is how an expense is detached from its event.
 */
function serialise<T extends object>(patch: T, decimals: Record<string, number> = {}): Row {
  const body: Row = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const scale = decimals[key]
    if (scale !== undefined && typeof value === 'number' && Number.isFinite(value)) {
      body[key] = value.toFixed(scale)
    } else {
      body[key] = value
    }
  }
  return body
}

/** People are written field by field: `Person` has no element the wire does not want. */
function personBody(input: Partial<Person>): Row {
  const body: Row = {}
  if (input.name !== undefined) body.name = input.name
  if (input.colour !== undefined) body.colour = input.colour
  if (input.email !== undefined) body.email = input.email
  if (input.isDefault !== undefined) body.isDefault = input.isDefault
  return body
}

/**
 * The read shape and the write shape of an event differ: a page holds `participants` as
 * `Person[]`, CAP wants link rows keyed by `person_ID`. Only `participantIds` is ever sent,
 * and sending it replaces the whole roster (CAP's deep update deletes the rows left out).
 */
function eventBody(input: EventPatch): Row {
  const body: Row = {}
  if (input.name !== undefined) body.name = input.name
  if (input.startsOn !== undefined) body.startsOn = input.startsOn
  if (input.endsOn !== undefined) body.endsOn = input.endsOn
  if (input.place !== undefined) body.place = input.place
  if (input.note !== undefined) body.note = input.note
  if (input.isSurprise !== undefined) body.isSurprise = input.isSurprise
  if (input.createdBy_ID !== undefined) body.createdBy_ID = input.createdBy_ID
  if (input.participantIds !== undefined) {
    body.participants = input.participantIds.map(id => ({ person_ID: id }))
  }
  // `revealedAt` and `photos` are deliberately absent: a secret is lifted by
  // `revealSurprise`, and pictures arrive through `addEventPhoto`. Neither is a PATCH.
  return body
}

/* ------------------------------------------------------------------ *
 *  Binary upload
 * ------------------------------------------------------------------ */

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
}

function mediaTypeOf(file: Blob, fileName: string): string {
  if (file.type) return file.type
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'image/jpeg'
}

/**
 * `scanReceipt` declares `image: LargeBinary`, which over HTTP is `Edm.Binary` — base64
 * inside the JSON action body. Chunked so a 10 MB photo does not blow the argument limit
 * of `String.fromCharCode`.
 */
async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/* ------------------------------------------------------------------ *
 *  Entity reads and writes
 * ------------------------------------------------------------------ */

async function listExpenses(opts: ExpenseQuery = {}): Promise<Expense[]> {
  const filters: string[] = []

  if (opts.period && PERIOD_RE.test(opts.period)) {
    const [from, to] = periodRange(opts.period)
    filters.push(`date ge ${from} and date le ${to}`)
  }
  if (opts.status) filters.push(`status eq ${literal(opts.status)}`)
  if (opts.category) filters.push(`category_code eq ${literal(opts.category)}`)
  if (opts.moment) filters.push(`moment eq ${literal(opts.moment)}`)
  if (opts.paidBy) filters.push(`paidBy_ID eq ${guidLiteral(opts.paidBy)}`)
  if (opts.event) filters.push(`event_ID eq ${guidLiteral(opts.event)}`)

  const params: Array<[string, string]> = [['$orderby', 'date desc,time desc,createdAt desc']]
  if (filters.length > 0) params.unshift(['$filter', filters.join(' and ')])
  if (opts.top && opts.top > 0) params.push(['$top', String(Math.floor(opts.top))])

  return unwrap(await request<unknown>(withQuery(`${BASE}/Expenses`, params))).map(toExpense)
}

async function getExpense(id: string): Promise<Expense> {
  return toExpense(await request<unknown>(`${BASE}/Expenses${keySegment(id)}`))
}

async function updateExpense(id: string, patch: Partial<Expense>): Promise<Expense> {
  const payload = await request<unknown>(`${BASE}/Expenses${keySegment(id)}`, {
    method: 'PATCH',
    body: serialise(patch, EXPENSE_DECIMALS),
  })
  // CAP answers 200 with the updated entity; a 204 would leave us nothing to return.
  return payload === undefined ? getExpense(id) : toExpense(payload)
}

async function deleteExpense(id: string): Promise<void> {
  await request<void>(`${BASE}/Expenses${keySegment(id)}`, { method: 'DELETE' })
}

async function createExpense(body: Partial<Expense>): Promise<Expense> {
  return toExpense(
    await request<unknown>(`${BASE}/Expenses`, {
      method: 'POST',
      body: serialise(body, EXPENSE_DECIMALS),
    }),
  )
}

async function listCategories(): Promise<Category[]> {
  const params: Array<[string, string]> = [['$orderby', 'sortOrder']]
  return unwrap(await request<unknown>(withQuery(`${BASE}/Categories`, params))).map(toCategory)
}

/** The household first, then everybody who was added for a trip or a dinner. */
async function listPeople(): Promise<Person[]> {
  const params: Array<[string, string]> = [['$orderby', 'isDefault desc,name']]
  return unwrap(await request<unknown>(withQuery(`${BASE}/People`, params))).map(toPerson)
}

async function readPerson(id: string): Promise<Person> {
  return toPerson(await request<unknown>(`${BASE}/People${keySegment(id)}`))
}

async function createPerson(body: Partial<Person>): Promise<Person> {
  const payload = await request<unknown>(`${BASE}/People`, {
    method: 'POST',
    body: personBody(body),
  })
  return toPerson(payload)
}

async function updatePerson(id: string, patch: Partial<Person>): Promise<Person> {
  const payload = await request<unknown>(`${BASE}/People${keySegment(id)}`, {
    method: 'PATCH',
    body: personBody(patch),
  })
  // A 204 leaves nothing to map; re-read rather than hand back a half-built person.
  return payload === undefined ? readPerson(id) : toPerson(payload)
}

/** The service refuses this while the person has postings, and says so in the message. */
async function deletePerson(id: string): Promise<void> {
  await request<void>(`${BASE}/People${keySegment(id)}`, { method: 'DELETE' })
}

async function listEvents(): Promise<Event[]> {
  const params: Array<[string, string]> = [
    ['$expand', PARTICIPANT_EXPAND],
    ['$orderby', 'startsOn desc'],
  ]
  return unwrap(await request<unknown>(withQuery(`${BASE}/Events`, params))).map(toEvent)
}

async function getEvent(id: string): Promise<Event> {
  const path = withQuery(`${BASE}/Events${keySegment(id)}`, [
    ['$expand', `${PARTICIPANT_EXPAND},${PHOTO_EXPAND}`],
  ])
  return toEvent(await request<unknown>(path))
}

/**
 * Every reminder, soonest first, with the ones already ticked off at the back.
 *
 * Sorted here rather than on the wire on purpose: `dueOn` is derived from the *event's*
 * `startsOn` minus `leadDays`, so no column on `Reminders` can be ordered by.
 */
async function listReminders(): Promise<Reminder[]> {
  const params: Array<[string, string]> = [['$expand', REMINDER_EXPAND]]
  const reminders = unwrap(await request<unknown>(withQuery(`${BASE}/Reminders`, params))).map(
    toReminder,
  )
  return reminders.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    // A reminder whose event could not be read has no date; park it at the end.
    if (a.dueOn === b.dueOn) return a.ID.localeCompare(b.ID)
    if (a.dueOn === null) return 1
    if (b.dueOn === null) return -1
    return a.dueOn < b.dueOn ? -1 : 1
  })
}

async function createEvent(body: NewEvent): Promise<Event> {
  const created = toEvent(
    await request<unknown>(`${BASE}/Events`, { method: 'POST', body: eventBody(body) }),
  )
  // The deep insert answers with bare link rows; re-read so the roster comes back expanded.
  return created.ID ? getEvent(created.ID) : created
}

async function updateEvent(id: string, patch: EventPatch): Promise<Event> {
  await request<unknown>(`${BASE}/Events${keySegment(id)}`, {
    method: 'PATCH',
    body: eventBody(patch),
  })
  return getEvent(id)
}

/** Detaches the event's expenses; it never deletes a posting. */
async function deleteEvent(id: string): Promise<void> {
  await request<void>(`${BASE}/Events${keySegment(id)}`, { method: 'DELETE' })
}

function toMood(payload: unknown): Mood {
  const row = (payload ?? {}) as Row
  return {
    ID: String(row.ID ?? ''),
    personId: strOrNull(row.person_ID),
    at: String(row.at ?? ''),
    level: Number(row.level ?? 3),
    note: strOrNull(row.note),
    source: row.source === 'face' ? 'face' : 'manual',
    detected: strOrNull(row.detected),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
  }
}

async function listMoods(): Promise<Mood[]> {
  const params: Array<[string, string]> = [
    ['$orderby', 'at desc'],
    ['$top', '90'],
  ]
  return unwrap(await request<unknown>(withQuery(`${BASE}/Moods`, params))).map(toMood)
}

async function createMood(body: {
  personId: string | null
  level: number
  note: string | null
  source: 'manual' | 'face'
  detected: string | null
  confidence: number | null
}): Promise<Mood> {
  return toMood(
    await request<unknown>(`${BASE}/Moods`, {
      method: 'POST',
      body: serialise(
        {
          person_ID: body.personId,
          at: new Date().toISOString(),
          level: body.level,
          note: body.note,
          source: body.source,
          detected: body.detected,
          confidence: body.confidence,
        },
        { confidence: 2 },
      ),
    }),
  )
}

/**
 * Ask the server to look at a face. The photograph goes up, a suggestion comes back, and
 * nothing is stored by this call — saving is `createMood`, which carries no image.
 */
async function detectMood(file: Blob): Promise<MoodSuggestion> {
  const image = await toBase64(file)
  const raw = (await request<unknown>(`${BASE}/detectMood`, {
    method: 'POST',
    body: JSON.stringify({ image, mediaType: file.type || 'image/jpeg' }),
  })) as Row
  return {
    level: Number(raw.level ?? 3),
    label: String(raw.label ?? ''),
    confidence: Number(raw.confidence ?? 0),
    observation: String(raw.observation ?? ''),
  }
}

async function listMemories(): Promise<Memory[]> {
  const params: Array<[string, string]> = [
    ['$expand', 'photos($select=ID,mediaType,caption)'],
    ['$orderby', 'occurredOn desc'],
  ]
  return unwrap(await request<unknown>(withQuery(`${BASE}/Memories`, params))).map(toMemory)
}

async function createMemory(body: Partial<Memory>): Promise<Memory> {
  return toMemory(
    await request<unknown>(`${BASE}/Memories`, { method: 'POST', body: serialise(body) }),
  )
}

async function updateMemory(id: string, patch: Partial<Memory>): Promise<Memory> {
  const payload = await request<unknown>(`${BASE}/Memories${keySegment(id)}`, {
    method: 'PATCH',
    body: serialise(patch),
  })
  return payload === undefined
    ? toMemory(await request<unknown>(`${BASE}/Memories${keySegment(id)}`))
    : toMemory(payload)
}

async function deleteMemory(id: string): Promise<void> {
  await request<void>(`${BASE}/Memories${keySegment(id)}`, { method: 'DELETE' })
}

async function listSettlements(): Promise<Settlement[]> {
  const params: Array<[string, string]> = [['$orderby', 'period desc']]
  return unwrap(await request<unknown>(withQuery(`${BASE}/Settlements`, params))).map(toSettlement)
}

async function listStatements(): Promise<Statement[]> {
  const params: Array<[string, string]> = [['$orderby', 'year desc']]
  return unwrap(await request<unknown>(withQuery(`${BASE}/Statements`, params))).map(toStatement)
}

/* ------------------------------------------------------------------ *
 *  Functions and actions
 * ------------------------------------------------------------------ */

/** What a month totalled, and who put in how much of it. */
async function periodTotals(period: string): Promise<PeriodTotals> {
  return toPeriodTotals(await request<unknown>(`${BASE}/periodTotals(period=${literal(period)})`))
}

/** The same arithmetic over one event, plus `perHead` for context. */
async function eventTotals(eventId: string): Promise<EventTotals> {
  const path = `${BASE}/eventTotals(eventId=${guidLiteral(eventId)})`
  return toEventTotals(await request<unknown>(path))
}

async function monthlyTotals(fromPeriod: string, toPeriod: string): Promise<MonthlyTotal[]> {
  const path = `${BASE}/monthlyTotals(fromPeriod=${literal(fromPeriod)},toPeriod=${literal(toPeriod)})`
  return unwrap(await request<unknown>(path)).map(toMonthlyTotal)
}

async function duplicates(id: string): Promise<Expense[]> {
  return unwrap(await request<unknown>(`${BASE}/duplicates(ID=${guidLiteral(id)})`)).map(toExpense)
}

async function confirmExpense(
  id: string,
  predictedCategory = '',
  predictedMoment = '',
): Promise<Expense> {
  return toExpense(
    await request<unknown>(`${BASE}/confirmExpense`, {
      method: 'POST',
      body: { ID: id, predictedCategory, predictedMoment },
    }),
  )
}

async function classify(id: string): Promise<Expense> {
  return toExpense(await request<unknown>(`${BASE}/classify`, { method: 'POST', body: { ID: id } }))
}

async function scanReceipt(file: Blob, fileName: string): Promise<ScanResult> {
  const image = await toBase64(file)
  return toScanResult(
    await request<unknown>(`${BASE}/scanReceipt`, {
      method: 'POST',
      body: { image, mediaType: mediaTypeOf(file, fileName), fileName },
    }),
  )
}

/** The period close. It stamps what the month totalled; it moves no money. */
async function runSettlement(period: string): Promise<Settlement> {
  return toSettlement(
    await request<unknown>(`${BASE}/runSettlement`, { method: 'POST', body: { period } }),
  )
}

/** Marks a closed period done and dusted. */
async function markSettled(id: string): Promise<Settlement> {
  return toSettlement(
    await request<unknown>(`${BASE}/markSettled`, { method: 'POST', body: { ID: id } }),
  )
}

async function generateStatement(year: number): Promise<Statement> {
  return toStatement(
    await request<unknown>(`${BASE}/generateStatement`, { method: 'POST', body: { year } }),
  )
}

/* ------------------------------------------------------------------ *
 *  Photos, reminders, surprises, calendar — CONTRACTS §11
 * ------------------------------------------------------------------ */

/**
 * Everything that lands between two inclusive `YYYY-MM-DD` days, events and reminders
 * flattened into one stream for the month grid. Both bounds are declared `String` in
 * `srv/ledger-service.cds`, in step with `periodTotals` and `monthlyTotals`, so they are
 * quoted literals — an `Edm.Date` parameter would want them bare instead.
 *
 * Surprises created by anybody other than the person asking are already gone by the time
 * this answers, so a row that says `onlyYou` is one to badge, never one to hide.
 */
async function upcoming(fromDate: string, toDate: string): Promise<CalendarEntry[]> {
  const path = `${BASE}/upcoming(fromDate=${literal(fromDate)},toDate=${literal(toDate)})`
  return unwrap(await request<unknown>(path)).map(toCalendarEntry)
}

/**
 * Uploads one picture to an event. The blob is base64'd into the action body exactly as
 * `scanReceipt` does it, so the server can put it through the single image pipeline
 * (`srv/lib/images.ts`: EXIF stripped, auto-rotated, 2000 px, JPEG q85) before storing it.
 * Any event accepts a photo — a picture taken on day one of a trip should not have to wait
 * for the trip to end.
 */
async function addEventPhoto(input: NewEventPhoto): Promise<EventPhoto> {
  const image = await toBase64(input.file)
  // The action takes bytes, a media type, and the two things a human supplies. `fileName`
  // is not one of its parameters — it only ever gets as far as sniffing the media type.
  const body: Row = {
    eventId: input.eventId,
    image,
    mediaType: mediaTypeOf(input.file, input.fileName),
    caption: input.caption ?? '',
  }
  // Omitted rather than nulled: the capture time is stripped with the rest of the EXIF,
  // so a date is worth sending only when somebody typed one.
  if (input.takenOn) body.takenOn = input.takenOn
  return toEventPhoto(await request<unknown>(`${BASE}/addEventPhoto`, { method: 'POST', body }))
}

async function deleteEventPhoto(id: string): Promise<void> {
  await request<void>(`${BASE}/deleteEventPhoto`, { method: 'POST', body: { ID: id } })
}

/**
 * Lifts the secret: stamps `revealedAt`, after which the event is ordinary and everybody
 * sees it. Re-read afterwards because an action answers with the bare row and a page wants
 * its roster and its pictures back with it.
 */
async function revealSurprise(eventId: string): Promise<Event> {
  const revealed = toEvent(
    await request<unknown>(`${BASE}/revealSurprise`, { method: 'POST', body: { ID: eventId } }),
  )
  return revealed.ID ? getEvent(revealed.ID) : revealed
}

async function readReminder(id: string): Promise<Reminder> {
  const path = withQuery(`${BASE}/Reminders${keySegment(id)}`, [['$expand', REMINDER_EXPAND]])
  return toReminder(await request<unknown>(path))
}

/** A nudge `leadDays` before the event starts. `leadDays: 0` means "on the day". */
async function createReminder(input: NewReminder): Promise<Reminder> {
  const leadDays = Number.isFinite(input.leadDays) ? Math.max(0, Math.round(input.leadDays)) : 1
  const created = toReminder(
    await request<unknown>(`${BASE}/createReminder`, {
      method: 'POST',
      body: { eventId: input.eventId, leadDays, note: input.note ?? '' },
    }),
  )
  // The action answers without the event expanded, so `dueOn` and `eventName` are still
  // blank; one re-read hands the caller the same shape `listReminders` produces.
  return created.ID ? readReminder(created.ID) : created
}

/** Ticks a reminder off. It stays in the list, at the back, rather than disappearing. */
async function completeReminder(id: string): Promise<Reminder> {
  await request<unknown>(`${BASE}/completeReminder`, { method: 'POST', body: { ID: id } })
  return readReminder(id)
}

function receiptImageUrl(receiptId: string): string {
  return `${BASE}/Receipts${keySegment(receiptId)}/image`
}

/** The media stream behind an `EventPhoto`; hand it straight to an `<img src>`. */
function eventPhotoUrl(photoId: string): string {
  return `${BASE}/EventPhotos${keySegment(photoId)}/image`
}

function photoImageUrl(photoId: string): string {
  return `${BASE}/Photos${keySegment(photoId)}/image`
}

async function health(): Promise<Health> {
  const row = asRow(await request<unknown>(HEALTH_PATH))
  const result: Health = {
    status: str(row.status, 'unknown'),
    docai: str(row.docai, 'unknown'),
    llm: str(row.llm, 'unknown'),
  }
  const model = strOrNull(row.model)
  if (model) result.model = model
  const version = strOrNull(row.version)
  if (version) result.version = version
  const uptime = numOrNull(row.uptime)
  if (uptime !== null) result.uptime = uptime
  return result
}

/** The whole client surface, exactly as FRONTEND-CONTRACT §3 declares it. */
export const api = {
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  createExpense,
  listCategories,
  listPeople,
  createPerson,
  updatePerson,
  deletePerson,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  listMoods,
  createMood,
  detectMood,
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  listSettlements,
  listStatements,
  listReminders,
  periodTotals,
  eventTotals,
  monthlyTotals,
  duplicates,
  confirmExpense,
  classify,
  scanReceipt,
  runSettlement,
  markSettled,
  generateStatement,
  upcoming,
  addEventPhoto,
  deleteEventPhoto,
  revealSurprise,
  createReminder,
  completeReminder,
  receiptImageUrl,
  photoImageUrl,
  eventPhotoUrl,
  health,
}

export type Api = typeof api
