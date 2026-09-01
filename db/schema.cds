/**
 * Two-Way Match — domain model.
 *
 * Shapes here are fixed by docs/CONTRACTS.md: the Python trainer, the TypeScript
 * inference port, the totals maths and the React app all read these names and
 * these enum strings. Renaming an element or an enum symbol breaks a contract.
 *
 * There is no debt in this model. An expense records who *paid* it and,
 * optionally, which *event* it belongs to. Everything downstream is a sum.
 */
namespace twowaymatch;

using {
  cuid,
  managed,
  User,
} from '@sap/cds/common';


/* ------------------------------------------------------------------ *
 *  Aspects
 * ------------------------------------------------------------------ */

/**
 * `managed`, minus its `createdBy`.
 *
 * WHY this exists at all: CONTRACTS.md §11.3 gives `Events` a
 * `createdBy : Association to People` — the person a surprise is hidden *for*
 * everybody but. `@sap/cds/common`'s `managed` already contributes a
 * `createdBy : User`, a plain string stamped with `$user`, and the compiler
 * refuses the collision outright:
 *
 *   Expected element "createdBy" not to be an association, because it overrides
 *   the included element from "managed"
 *
 * An aspect cannot be included-minus-an-element, so the three elements that do
 * not clash are restated here and the fourth is left to the entity. Everything
 * else about `Events` is unchanged: it still stamps `createdAt`, still tracks
 * who last touched it, and still has exactly the columns it had — with
 * `createdBy` now naming a row in `People` rather than a login name.
 *
 * Nothing else in the model uses this. Every other entity keeps plain `managed`.
 */
aspect authored {
  createdAt  : Timestamp @cds.on.insert: $now;
  modifiedAt : Timestamp @cds.on.insert: $now  @cds.on.update: $now;
  modifiedBy : User      @cds.on.insert: $user @cds.on.update: $user;
}


/* ------------------------------------------------------------------ *
 *  Code sets — CONTRACTS.md §1.2 / §1.3
 *
 *  These are CDS enums (not code lists) on purpose: the values are part of
 *  the cross-language contract, so we want the compiler and cds-typer to
 *  reject a typo instead of letting a bad string reach the classifier.
 *  Category codes are deliberately NOT an enum — they live in a seeded
 *  code list so display metadata stays editable at runtime.
 * ------------------------------------------------------------------ */

/** Why an expense happened. Second head of the classifier. */
type MomentCode : String(20) enum {
  everyday;
  date_night;
  trip;
  gift;
}

/** Draft rows are unposted: they carry no document number and never close. */
type ExpenseStatus : String(20) enum {
  draft;
  confirmed;
}

/** Where the row came from — used to explain low confidences to the user. */
type ExpenseSource : String(20) enum {
  scan;
  import;
  manual;
}

/** Lifecycle of a Document AI job; `mock` means the bundled fixture answered. */
type ExtractionStatus : String(20) enum {
  pending;
  done;
  failed;
  mock;
}

/** Timeline flavour. Mirrors MomentCode plus the two memory-only kinds. */
type MemoryKind : String(20) enum {
  date_night;
  trip;
  gift;
  anniversary;
  other;
}

/** A period is `open` while it is still being posted to, `settled` once closed. */
type SettlementStatus : String(20) enum {
  open;
  settled;
}

/** Which classifier head a correction refers to. */
type CorrectionField : String(20) enum {
  category;
  moment;
}


/* ------------------------------------------------------------------ *
 *  Master data
 * ------------------------------------------------------------------ */

/**
 * Everybody who can pay for something. Any number of rows; two are seeded
 * with `isDefault` so the app is usable on first run (CONTRACTS.md §10).
 * Nothing in the codebase may assume a particular count or ordering.
 *
 * `@singular` is not cosmetic: without it cds-typer would derive a mangled
 * singular from "People", and every TypeScript handler would import the typo.
 */
@singular: 'Person'
@plural  : 'People'
entity People : cuid, managed {
  name      : String(100);
  /** Hex colour used for this person's avatar. The UI never hardcodes a hue. */
  colour    : String(20);
  email     : String(200);
  /** Seeded members of the household; shown first in pickers. */
  isDefault : Boolean default false;
}

/**
 * A trip, a dinner, a party — anything worth grouping spend under.
 * Expenses may point at one; most point at none and are everyday spending.
 */
@singular: 'Event'
@plural  : 'Events'
entity Events : cuid, authored {
  name         : String(120);
  startsOn     : Date;
  /** Null for a single-day event. */
  endsOn       : Date null;
  place        : String(200);
  note         : LargeString;
  participants : Composition of many EventParticipants
                   on participants.event = $self;
  /**
   * Photographs of the event (CONTRACTS.md §11.1). A composition, so deleting
   * an event takes its pictures with it — unlike its expenses, a photo of a
   * trip is not a fact that outlives the trip.
   */
  photos       : Composition of many EventPhotos
                   on photos.event = $self;
  /** Nudges before it starts (CONTRACTS.md §11.2). Also a composition. */
  reminders    : Composition of many Reminders
                   on reminders.event = $self;
  /**
   * A surprise is visible only to `createdBy` until `revealedAt` is stamped or
   * `startsOn` has passed, whichever comes first (CONTRACTS.md §11.3). The
   * hiding is done by `LedgerService`; the model only records the intent.
   */
  isSurprise   : Boolean default false;
  /**
   * Who planned it — and, while `isSurprise` holds, the only person who can see
   * it. An association to a row in `People`, not the `managed` login name; see
   * the `authored` aspect at the top of this file for why `managed` is not
   * included here.
   */
  createdBy    : Association to People;
  /** When the surprise was let out. Null while it is still a secret. */
  revealedAt   : Timestamp null;
  /**
   * Backlink for the event totals. An association, not a composition:
   * deleting an event detaches its expenses, it never deletes them.
   */
  expenses     : Association to many Expenses
                   on expenses.event = $self;
}

/**
 * Link table between an event and the people on it. The key is the pair, so
 * the same person cannot be added to the same event twice.
 */
@singular: 'EventParticipant'
@plural  : 'EventParticipants'
entity EventParticipants {
  key event  : Association to Events;
  key person : Association to People;
}

/**
 * Pictures of an event (CONTRACTS.md §11.1).
 *
 * Structurally identical to `Photos` on `Memories`, and deliberately so: the
 * same `@Core.MediaType` pairing makes `image` a real OData media stream, and
 * every byte that reaches it has been through `srv/lib/images.ts` first, so no
 * EXIF — no GPS, no device serial, no capture time — is ever stored. `takenOn`
 * is the one piece of that metadata worth keeping, and it is kept because a
 * human typed it, not because a camera whispered it.
 *
 * `@singular` matters here for the same reason it does on `Expenses`: cds-typer
 * derives the singular itself otherwise, and every handler would import it.
 */
@singular: 'EventPhoto'
@plural  : 'EventPhotos'
entity EventPhotos : cuid, managed {
  event     : Association to Events;
  image     : LargeBinary @Core.MediaType: mediaType;
  mediaType : String(50)  @Core.IsMediaType;
  caption   : String(200);
  /** The day the picture was taken, when it is not the day it was uploaded. */
  takenOn   : Date;
}

/**
 * A nudge before an event starts (CONTRACTS.md §11.2).
 *
 * `dueOn` is deliberately *not* a column: it is `startsOn - leadDays`, and a
 * stored copy would go stale the moment an event is moved. The service computes
 * it with `addDays` from `srv/lib/dates.ts`, which is the only date arithmetic
 * in this repo.
 */
@singular: 'Reminder'
@plural  : 'Reminders'
entity Reminders : cuid, managed {
  event    : Association to Events;
  /** Whole days before `event.startsOn` that this fires. */
  leadDays : Integer default 1;
  note     : String(200);
  done     : Boolean default false;
}

/**
 * Spending categories. `code` is the key because it is the exact ASCII string
 * shared with the Python trainer (CONTRACTS.md §1.1); everything else is
 * display metadata that a human may re-theme without touching the model.
 */
entity Categories {
  key code      : String(20);
      name      : String(100);
      icon      : String(50);
      colour    : String(20);
      sortOrder : Integer;
}


/* ------------------------------------------------------------------ *
 *  Transactional data
 * ------------------------------------------------------------------ */

/**
 * One posted (or drafted) spend. The classifier writes `category`/`moment`
 * plus their confidences; the human confirms them, and every disagreement is
 * logged in Corrections so the next training round learns from it.
 *
 * `@singular` is not cosmetic: without it cds-typer derives the singular from
 * "Expenses" as `Expens`, and every TypeScript handler would have to import
 * that typo from #cds-models.
 */
@singular: 'Expense'
entity Expenses : cuid, managed {
  date               : Date;
  time               : Time;
  /** Exactly as it appeared on the receipt — the classifier's raw input. */
  merchantRaw        : String(200);
  /** Output of normaliseMerchant() (CONTRACTS.md §2.1); also the duplicate key. */
  merchantNorm       : String(200);
  amount             : Decimal(10, 2);
  currency           : String(3) default 'CHF';
  category           : Association to Categories;
  categoryConfidence : Decimal(5, 4);
  moment             : MomentCode;
  momentConfidence   : Decimal(5, 4);
  /** Who actually paid. Not a claim on anybody else (CONTRACTS.md §9). */
  paidBy             : Association to People;
  /** Null means everyday spending; otherwise the event this belongs to. */
  event              : Association to Events null;
  /** New rows are unposted until confirmExpense() runs (CONTRACTS.md §10). */
  status             : ExpenseStatus default 'draft';
  source             : ExpenseSource;
  note               : LargeString;
  place              : String(200);
  lat                : Double null;
  lon                : Double null;
  receipt            : Association to Receipts;
  /** Human-readable posting number, assigned on confirm. Document #1 is the first date. */
  documentNumber     : Integer;
  /** Set by the period close; a non-null value means the month is reported on. */
  settlement         : Association to Settlements null;
  /** Backlink so `where not exists memories` finds moments nobody wrote up yet. */
  memories           : Association to many Memories
                         on memories.expense = $self;
  /** Backlink so the training-data export can expand the corrections in one read. */
  corrections        : Association to many Corrections
                         on corrections.expense = $self;
}

/**
 * The scanned image plus the raw Document AI answer. The extraction JSON is
 * kept verbatim so a mapper fix can be replayed without re-uploading anything.
 */
entity Receipts : cuid, managed {
  image            : LargeBinary @Core.MediaType: mediaType;
  mediaType        : String(50)  @Core.IsMediaType;
  fileName         : String(200);
  docaiJobId       : String(100);
  extraction       : LargeString;
  extractionStatus : ExtractionStatus;
}

/**
 * The romantic layer: a story attached to (optionally) an expense. Kept
 * separate from Expenses so a memory can outlive or precede any posting.
 */
/**
 * One reading of how somebody felt.
 *
 * `level` is the whole scale: 1 (rough) to 5 (great). Small on purpose — a mood is a
 * glance, not a survey, and five faces fit under a thumb.
 *
 * When the reading came from the camera (`source = 'face'`), `detected` is the label the
 * model gave and `confidence` its own estimate of it. The photograph itself is **never
 * stored** — it is looked at, answered about, and discarded (srv/lib/mood.ts). A ledger
 * of receipts is one thing; an archive of face photos is not something this app keeps.
 */
entity Moods : cuid, managed {
  person     : Association to People;
  /** Timestamp rather than DateTime: the client sends `new Date().toISOString()`, and a
      type that rejects the milliseconds in that string would 400 every save. */
  at         : Timestamp;
  level      : Integer;
  note       : String(280);
  /** 'manual' when tapped in, 'face' when detected from the camera. */
  source     : String(10) default 'manual';
  /** The model's word for what it saw, e.g. "content" — only when source = 'face'. */
  detected   : String(60);
  /** The model's own 0..1 estimate — only when source = 'face'. Never invented. */
  confidence : Decimal(3, 2);
}

entity Memories : cuid, managed {
  expense    : Association to Expenses null;
  title      : String(200);
  note       : LargeString;
  occurredOn : Date;
  kind       : MemoryKind;
  pinned     : Boolean default false;
  /** Free-text location; geocoded to lat/lon so the map view can pin it. */
  place      : String(200);
  lat        : Double null;
  lon        : Double null;
  photos     : Composition of many Photos
                 on photos.memory = $self;
}

/** Images belonging to a memory. A composition so deleting a memory cleans up. */
entity Photos : cuid, managed {
  memory    : Association to Memories;
  image     : LargeBinary @Core.MediaType: mediaType;
  mediaType : String(50)  @Core.IsMediaType;
  caption   : String(200);
}

/**
 * One closed period. The monthly "payment run" writes a row here recording
 * what the month totalled, so it can be marked done and reported on later.
 * It moves no money and it computes no debt (CONTRACTS.md §9).
 */
entity Settlements : cuid, managed {
  /** YYYY-MM. */
  period           : String(7);
  /** Everything posted in the period, frozen at close time. */
  grandTotal       : Decimal(10, 2);
  status           : SettlementStatus;
  settledAt        : Timestamp;
  clearingDocument : String(20);
  approvedBy       : String(100);
  /** Backlink: the line items this close covered, for the clearing-document view. */
  expenses         : Association to many Expenses
                       on expenses.settlement = $self;
}

/** The generated yearly "Statement of Us", stored so it can be re-read offline. */
entity Statements : cuid, managed {
  year            : Integer;
  contentMarkdown : LargeString;
  generatedAt     : Timestamp;
  /** Which LLM provider produced it — 'template' when no credentials exist. */
  engine          : String(50);
}

/**
 * Training-data log: every time the human overrules a prediction we keep both
 * labels, which is the entire input to the continuous-learning loop.
 */
entity Corrections : cuid {
  expense   : Association to Expenses;
  field     : CorrectionField;
  predicted : String(50);
  corrected : String(50);
  createdAt : Timestamp @cds.on.insert: $now;
}
