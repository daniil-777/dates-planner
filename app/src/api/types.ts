/**
 * DTOs for the LedgerService — FRONTEND-CONTRACT §2.
 *
 * These mirror `db/schema.cds` as it is projected by `srv/ledger-service.cds`, with two
 * deliberate differences from what the wire actually carries:
 *
 *  1. every `Decimal` is a `number` here, because `app/src/api/client.ts` coerces the
 *     JSON strings OData V4 sends (`"148.50"`) before a page ever sees them;
 *  2. associations arrive flattened as foreign keys (`category_code`, `paidBy_ID`,
 *     `event_ID`, …), which is what CAP serialises for a non-expanded association.
 *
 * Do not widen a field to `string | number` "just in case" — the coercion in the client
 * is the single place that deals with the wire format.
 *
 * One thing this app deliberately does not model: debt. An expense records who *paid*
 * it and, optionally, which event it belongs to. Every aggregate below is a sum with a
 * proportion beside it, never a claim on anybody.
 */

export type MomentCode = 'everyday' | 'date_night' | 'trip' | 'gift'
export type ExpenseStatus = 'draft' | 'confirmed'
export type ExpenseSource = 'scan' | 'import' | 'manual'
export type MemoryKind = 'date_night' | 'trip' | 'gift' | 'anniversary' | 'other'

/**
 * Somebody who pays for things. There may be two of them or ten; `isDefault` marks the
 * ones seeded with the household rather than added later for a single trip.
 */
export interface Person {
  ID: string
  name: string
  /** Hex, e.g. '#0070F2'. The UI reads its accent from here and never hardcodes a hue. */
  colour: string
  email?: string
  isDefault: boolean
}

/** A trip, a dinner, a party — a bag that a subset of the people and some postings share. */
export interface Event {
  ID: string
  name: string
  /** 'YYYY-MM-DD'. */
  startsOn: string
  /** 'YYYY-MM-DD', or null for a single-day event. */
  endsOn: string | null
  place: string | null
  note: string | null
  /** Expanded by the client from `participants($expand=person)`; never just ids up here. */
  participants: Person[]
  /**
   * CONTRACTS §11.3. A surprise is visible only to `createdBy` until `revealedAt` is
   * stamped or `startsOn` has passed — so an event that arrives here with `isSurprise`
   * still true and `revealedAt` still null is one *the current person created*. The
   * service has already hidden everybody else's; the UI only has to badge this one
   * "Only you can see this" and offer Reveal.
   *
   * Optional because a page may build an `Event` literal for a fixture without caring;
   * every event the client returns carries a real boolean.
   */
  isSurprise?: boolean
  /** Who created it. Only meaningful for surprises, but the service sends it always. */
  createdBy_ID?: string | null
  /** ISO timestamp of the reveal, or null while it is still a secret. */
  revealedAt?: string | null
  /** Expanded on `getEvent`, absent on `listEvents` — pictures are not list data. */
  photos?: EventPhoto[]
}

/**
 * A picture hanging off an event (CONTRACTS §11.1). The bytes are an OData media
 * stream at `api.eventPhotoUrl(ID)`; only the metadata travels as JSON.
 */
export interface EventPhoto {
  ID: string
  event_ID: string | null
  mediaType: string
  caption: string | null
  /** 'YYYY-MM-DD' — when the picture was taken, not when it was uploaded. */
  takenOn: string | null
}

/**
 * Arguments for `api.addEventPhoto`. The blob is base64'd into the action body by the
 * client, exactly as `scanReceipt` does it; the server runs it through the one image
 * pipeline (`srv/lib/images.ts`) and stores the result.
 */
export interface NewEventPhoto {
  eventId: string
  file: Blob
  /**
   * Only used to work out the media type when the blob carries none — a canvas re-encode
   * has no `type`. The name itself is never sent: the action takes the bytes, not a file.
   */
  fileName: string
  caption?: string | null
  /**
   * 'YYYY-MM-DD'. Omitted when absent — the capture time is stripped out of the EXIF with
   * everything else, so this is worth storing only when a human typed it.
   */
  takenOn?: string | null
}

/**
 * A nudge that fires `leadDays` before its event starts (CONTRACTS §11.2).
 *
 * `dueOn` is `startsOn - leadDays`. The service may send it; when it does not, the
 * client derives it from the expanded event so a page never has to do date maths to
 * find out when a reminder lands.
 */
export interface Reminder {
  ID: string
  event_ID: string | null
  leadDays: number
  note: string | null
  done: boolean
  /** 'YYYY-MM-DD', or null when the event behind it could not be read. */
  dueOn: string | null
  /** From the expanded event, so a reminder list needs no second round trip. */
  eventName: string | null
  /** 'YYYY-MM-DD' of the event the reminder points at. */
  eventStartsOn: string | null
}

/** Body accepted by `api.createReminder`. */
export interface NewReminder {
  eventId: string
  /** How many days before `startsOn` it fires. 0 means "on the day". */
  leadDays: number
  note?: string | null
}

/** An `upcoming` row is either the event itself or a reminder pointing at one. */
export type CalendarEntryKind = 'event' | 'reminder'

/**
 * One row of `upcoming(fromDate, toDate)` — the calendar's only read.
 *
 * Events and reminders are flattened into a single stream so the month grid can bucket
 * everything by `date` in one pass. A multi-day event arrives **once per day it covers**,
 * each row carrying the same `ID` and the same `endsOn` — so `ID` is not unique within a
 * response, and a key for a React list has to combine `date` with it.
 *
 * Surprises the current person did not create never appear here (CONTRACTS §11.3), so a
 * row with `onlyYou` set is always one to badge, never one to hide.
 */
export interface CalendarEntry {
  /** The `Events.ID` or `Reminders.ID` this row came from. */
  ID: string
  kind: CalendarEntryKind
  /** 'YYYY-MM-DD' — the day this belongs on: a day the event covers, or the reminder's due day. */
  date: string
  /** Last day of a multi-day event; null for a one-day event and for every reminder. */
  endsOn: string | null
  /** The event's name; a reminder borrows it so the grid reads the same either way. */
  title: string
  place: string | null
  /** Where tapping navigates — `/events/:eventId`. Equal to `ID` when `kind` is 'event'. */
  eventId: string | null
  /** True when this is a surprise only the person asking can see. */
  onlyYou: boolean
  /** Reminders only: how many days before the event it fires. Null on an event row. */
  leadDays: number | null
  /** Reminders only: whether it has been ticked off. Null on an event row. */
  done: boolean | null
}

/** Body accepted by `api.createEvent`: the event's own fields plus who is on it. */
export type NewEvent = Partial<Event> & { participantIds: string[] }

/** Patch accepted by `api.updateEvent`. Passing `participantIds` replaces the whole roster. */
export type EventPatch = Partial<Event> & { participantIds?: string[] }

export interface Category {
  code: string
  name: string
  icon: string
  colour: string
  sortOrder: number
}

export interface Expense {
  ID: string
  date: string
  time: string | null
  merchantRaw: string
  merchantNorm: string | null
  amount: number
  currency: string
  category_code: string | null
  categoryConfidence: number | null
  moment: MomentCode | null
  momentConfidence: number | null
  paidBy_ID: string | null
  /** null = everyday spending, not part of an event. */
  event_ID: string | null
  status: ExpenseStatus
  source: ExpenseSource
  note: string | null
  place: string | null
  lat: number | null
  lon: number | null
  receipt_ID: string | null
  documentNumber: number | null
  settlement_ID: string | null
}

export interface Photo {
  ID: string
  mediaType: string
  caption: string | null
}

export interface Memory {
  ID: string
  expense_ID: string | null
  title: string
  note: string | null
  occurredOn: string
  kind: MemoryKind
  pinned: boolean
  place: string | null
  lat: number | null
  lon: number | null
  photos?: Photo[]
}

/** A closed period. It records what a month totalled; it moves no money. */
export interface Settlement {
  ID: string
  period: string
  grandTotal: number
  status: 'open' | 'settled'
  settledAt: string | null
  clearingDocument: string
  approvedBy: string
}

export interface Statement {
  ID: string
  year: number
  contentMarkdown: string
  generatedAt: string
  engine: string
}

/** What one person put in, over whatever set of postings the aggregate covers. */
export interface PersonTotal {
  personId: string
  name: string
  /** What this person actually paid out. */
  paid: number
  /** How many postings they paid for. */
  count: number
  /** `paid / grandTotal`, 0..1 — a proportion of the spend, NOT a debt. */
  share: number
}

/** `periodTotals('YYYY-MM')`. Everybody appears, including the people who paid nothing. */
export interface PeriodTotals {
  period: string
  grandTotal: number
  count: number
  byPerson: PersonTotal[]
}

/** `eventTotals(<event id>)`. `perHead` is context — 'CHF 540 each' — and nothing more. */
export interface EventTotals {
  eventId: string
  name: string
  grandTotal: number
  perHead: number
  participantCount: number
  count: number
  byPerson: PersonTotal[]
}

export interface MonthlyTotal {
  period: string
  category: string
  total: number
}

/** One entry of a classifier head's top-3, as `srv/lib/classifier` scores it. */
export interface ScoredLabel {
  label: string
  p: number
}

/** scanReceipt returns a draft Expense plus review metadata. */
export interface ScanResult extends Expense {
  needsReview?: boolean
  categoryTop3?: ScoredLabel[]
  momentTop3?: ScoredLabel[]
}

/** `GET /health` — the probe `srv/server.ts` serves outside the OData router. */
export interface Health {
  status: string
  model?: string
  docai: string
  llm: string
  version?: string
  uptime?: number
}

/** Filter arguments accepted by `api.listExpenses` / `useExpenses`. */
export interface ExpenseQuery {
  /** 'YYYY-MM' — matched against `date`, inclusive of both month boundaries. */
  period?: string
  status?: ExpenseStatus
  /** A `Categories.code`, e.g. 'Dining'. */
  category?: string
  moment?: MomentCode
  /** A `People.ID`. */
  paidBy?: string
  /** An `Events.ID` — the postings booked on one event. */
  event?: string
  top?: number
}
