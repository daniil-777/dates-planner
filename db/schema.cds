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


/* ------------------------------------------------------------------ *
 *  Platform: groups, accounts, membership   (TWM-ADR-002, phase 0)
 * ------------------------------------------------------------------ */

/**
 * A household that registered on the platform. Every row that belongs to a household
 * points at exactly one Group through the `tenant` aspect below; the service narrows
 * every query to the caller's group before CAP builds SQL (LedgerService.scopeToGroup,
 * phase 1). `kind` drives copy and defaults only — never behaviour. It is deliberately
 * not a description of who the people are; see CONTRACTS.md §12.4.
 */
@singular: 'Group'
@plural: 'Groups'
entity Groups : cuid, managed {
  name            : String(120);
  kind            : String(20) enum {
    couple;
    household;
    friends;
    family;
    other;
  } default 'couple';
  currency        : String(3) default 'CHF';
  /**
   * The household this instance falls back to when a request names none — a session
   * minted before phase 1, or development with the door open.
   *
   * A marker rather than a rule: "the oldest group" and "the first group by id" both
   * look reasonable and are both wrong the moment a second household exists, because
   * a new group can sort ahead of the seeded one. Exactly one row should carry this.
   */
  isDefault       : Boolean default false;
  /** Eight characters, shown once, single use, rotated by an owner on demand. */
  inviteCode      : String(12);
  inviteExpiresAt : Timestamp null;
  members         : Composition of many Memberships
                      on members.group = $self;
}

/**
 * A login. Separate from People on purpose: a User is who typed the password, a Person
 * is a seat in one group's roster. One User may hold seats in several Groups.
 */
@singular: 'User'
@plural: 'Users'
entity Users : cuid, managed {
  email        : String(200);
  /** bcrypt. Never selected by any projection, never logged. */
  passwordHash : String(80);
  displayName  : String(100);
  /**
   * Optional, self-described, in the person's own words. Not an enum and not required:
   * classifying people by sex or orientation is special-category data under GDPR Art. 9
   * and the FADP, and nothing in this app has a purpose for it (ADR-002 §6).
   */
  gender       : String(40);
  memberships  : Association to many Memberships
                   on memberships.user = $self;
}

/** Binds a User to a Group and to that user's Person row inside it. */
@singular: 'Membership'
@plural: 'Memberships'
entity Memberships : cuid, managed {
  user   : Association to Users;
  group  : Association to Groups;
  person : Association to People;
  role   : String(10) enum {
    owner;
    member;
  } default 'member';
}

/**
 * Mixed into every entity that belongs to a household.
 *
 * Phase 0 (this change): nullable, backfilled to the seeded default group so every
 * existing row, test and screen keeps working. Phase 1 makes it mandatory and installs
 * the narrowing handler. Categories are the one shared vocabulary and carry no group.
 */
aspect tenant {
  group : Association to Groups;
}

/* ------------------------------------------------------------------ *
 *  Chat   (TWM-ADR-002 §5)
 * ------------------------------------------------------------------ */

/** One thread per group by default; `direct` threads are a later option. */
@singular: 'Conversation'
@plural: 'Conversations'
entity Conversations : cuid, managed, tenant {
  kind     : String(10) enum {
    group;
    direct;
  } default 'group';
  title    : String(120);
  messages : Composition of many Messages
               on messages.conversation = $self;
}

/**
 * A message. `kind` decides which columns matter: `text` uses body; `audio` and `image`
 * use media/mediaType, and audio also carries durationMs and `peaks` — a short JSON array
 * of 0..1 amplitudes captured while recording, so a thread can draw the waveform before a
 * byte of audio is fetched. Media is only ever served through the API (/Messages(id)/media).
 */
@singular: 'Message'
@plural: 'Messages'
entity Messages : cuid, managed, tenant {
  conversation : Association to Conversations;
  author       : Association to People;
  kind         : String(10) enum {
    text;
    audio;
    image;
  } default 'text';
  body         : String(4000);
  media        : LargeBinary @Core.MediaType: mediaType;
  mediaType    : String(50);
  /** Audio only. Enforced ≤ 120 000 by the service. */
  durationMs   : Integer;
  /** Audio only. JSON array of amplitudes, ~40 per second. */
  peaks        : LargeString;
}


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
entity People: cuid, managed, tenant {
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
entity Events: cuid, authored, tenant {
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
entity EventParticipants : tenant {
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
entity EventPhotos: cuid, managed, tenant {
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
entity Reminders: cuid, managed, tenant {
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
entity Expenses: cuid, managed, tenant {
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
entity Receipts: cuid, managed, tenant {
  image            : LargeBinary @Core.MediaType: mediaType;
  mediaType        : String(50)  @Core.IsMediaType;
  fileName         : String(200);
  docaiJobId       : String(100);
  extraction       : LargeString;
  extractionStatus : ExtractionStatus;
}

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
entity Moods: cuid, managed, tenant {
  person     : Association to People;
  /** Timestamp rather than DateTime: the client sends `new Date().toISOString()`, and a
      type that rejects the milliseconds in that string would 400 every save. */
  at         : Timestamp;
  /** The whole scale is 1..5, and the service refuses anything else: `clampReading` guards
      the camera path, this guards the POST — a level of 0 or 9 must not reach a chart. */
  @mandatory @assert.range: [1, 5]
  level      : Integer;
  note       : String(280);
  /** 'manual' when tapped in, 'face' when detected from the camera. */
  @assert.range
  source     : String(10) enum {
    manual;
    face;
  } default 'manual';
  /** The model's word for what it saw, e.g. "content" — only when source = 'face'. */
  detected   : String(60);
  /** The model's own 0..1 estimate — only when source = 'face'. Never invented. */
  confidence : Decimal(3, 2);
}

/**
 * The romantic layer: a story attached to (optionally) an expense. Kept
 * separate from Expenses so a memory can outlive or precede any posting.
 */
entity Memories: cuid, managed, tenant {
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
entity Photos: cuid, managed, tenant {
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
entity Settlements: cuid, managed, tenant {
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
entity Statements: cuid, managed, tenant {
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
entity Corrections: cuid, tenant {
  expense   : Association to Expenses;
  field     : CorrectionField;
  predicted : String(50);
  corrected : String(50);
  createdAt : Timestamp @cds.on.insert: $now;
}

/**
 * A person's touch map (CONTRACTS.md §13).
 *
 * ## Why this is modelled per person, not per couple
 *
 * The figure is one someone picks for *themselves*, and the preferences on it are
 * theirs. Two people in a household each keep their own map; the pairing anybody
 * wants to see — two women, two men, a man and a woman — falls out of the two
 * individual choices rather than being stored as a property of the couple. That is
 * deliberate: a "couple type" column would be an orientation field wearing a hat,
 * and TWM-ADR-002 §4 rules those out. `form` says which mannequin to draw and
 * nothing else.
 *
 * ## The most sensitive rows in the database
 *
 * This is Article 9 / FADP special-category data. Three consequences, all enforced
 * elsewhere and recorded here so the next reader does not have to rediscover them:
 * it is tenant-scoped like everything else; `guardBodyMapWrite` refuses a write to
 * anybody else's map, so the roster cannot be edited on someone's behalf; and it is
 * absent from `srv/lib/statement.ts`, whose five-table allowlist is what keeps
 * household facts out of LLM prompts. Nothing here is ever sent to a model.
 */
entity BodyMaps: cuid, managed, tenant {
  person : Association to People;
  /**
   * Which mannequin to draw. Not a statement about the person beyond the drawing —
   * see the entity doc.
   */
  @assert.range
  form   : String(10) enum {
    feminine;
    masculine;
    neutral;
  } default 'neutral';
  zones  : Composition of many BodyZones
             on zones.map = $self;
}

/**
 * One region of one person's map. A region with no row is one they have not said
 * anything about, which is different from a region they have marked `-1`.
 */
entity BodyZones: cuid, managed, tenant {
  map   : Association to BodyMaps;
  /** A code from the fixed list in CONTRACTS.md §13.1. */
  @mandatory
  zone  : String(24);
  /**
   * -1 rather not · 1 gently · 2 yes · 3 favourite. There is no 0: a region with no
   * opinion carries no row. The negative end exists because "not here" is the more
   * important half of what this feature is for.
   */
  @mandatory @assert.range: [-1, 3]
  level : Integer;
  note  : String(200);
}

/* ------------------------------------------------------------------ *
 *  The commons   (TWM-ADR-003)
 * ------------------------------------------------------------------ *
 *
 *  The one part of this database that is NOT a household's private data, and
 *  the only place where something a household typed can be read by strangers.
 *  Everything about it is arranged so that stays true in the narrow sense and
 *  in no wider one.
 *
 *  Three rules hold for every entity below, and each is visible in the code
 *  rather than left to discipline:
 *
 *  1. **No `tenant` aspect.** These rows have no `group` column, so
 *     `scopeToGroup` has nothing to narrow and is never registered on them.
 *     That is the whole difference between the commons and the rest of the app,
 *     and it is one word — its absence.
 *
 *  2. **No `managed` aspect.** CAP's `managed` stamps `createdBy` and
 *     `modifiedBy` with the login name. On a household table that is an audit
 *     trail; here it would be a byline on an anonymous review. `createdAt` is
 *     declared by hand where it is wanted, and the two `*By` columns do not
 *     exist to be leaked.
 *
 *  3. **No association to a tenant entity.** A published rating cannot be
 *     joined to an expense, an event, a memory or a person, because there is no
 *     column to join on. Authorship is an opaque `authorKey` — an HMAC of the
 *     group id under a server secret — which is enough to enforce one rating per
 *     group and to let a group withdraw its own, and is not enough to identify
 *     anybody or to join anything. See `srv/lib/commons/author.ts`.
 */

/** Roughly what an evening at a place costs **one person**, not a couple: this app
 *  has never assumed a household is two people and must not start here. */
type CostBand : String(12) enum {
  free;
  under_15;
  c15_30;
  c30_60;
  c60_120;
  over_120;
}

type PlaceKind : String(20) enum {
  restaurant;
  cafe;
  bar;
  activity;
  outdoors;
  culture;
  shop;
  other;
}

/**
 * A place in the shared corpus. Identity comes from OpenStreetMap where there is
 * an id for it, and from rounded coordinates where there is not (ADR-003 §3).
 */
entity Places : cuid {
  @mandatory
  name      : String(200);
  kind      : PlaceKind default 'other';
  @mandatory
  lat       : Double;
  @mandatory
  lon       : Double;
  /**
   * Six-character geohash, about a 1.2 km cell. "Near me" is a prefix match over
   * the nine cells around a point, which is an index range scan on SQLite today
   * and on Postgres later — no PostGIS, no extension, no rewrite (ADR-003 §8).
   */
  @mandatory
  geohash6  : String(6);
  city      : String(120);
  /** ISO 3166-1 alpha-2, upper case. */
  country   : String(2);
  /** `node` | `way` | `relation`, and the OSM id, when the place came from OSM. */
  osmType   : String(10);
  osmId     : String(24);
  createdAt : Timestamp;
  stats     : Composition of one PlaceStats
                on stats.place = $self;
  ratings   : Composition of many PlaceRatings
                on ratings.place = $self;
}

/**
 * One household's verdict on one place. Never projected into any read model:
 * discovery reads `PlaceStats`, and this table exists to be aggregated, to be
 * unique per author, and to be withdrawn.
 */
entity PlaceRatings : cuid {
  place     : Association to Places;
  /**
   * HMAC of the rating group's id. Opaque, stable, and unique together with
   * `place` — which is what enforces one rating per household per place, and
   * what lets that household take it back later.
   */
  @mandatory
  authorKey : String(64);
  @mandatory @assert.range: [1, 5]
  stars     : Integer;
  costBand  : CostBand;
  /** Optional, 240 characters, published only above the k-anonymity threshold. */
  tip       : String(240);
  /** Set when somebody reports the tip; a reported tip is hidden, not deleted. */
  tipHidden : Boolean default false;
  createdAt : Timestamp;
  tags      : Composition of many PlaceRatingTags
                on tags.rating = $self;
}

/** A chip from the fixed vocabulary in CONTRACTS.md §14.2. */
entity PlaceRatingTags {
  key rating : Association to PlaceRatings;
  key tag    : String(24);
}

/**
 * The read model, denormalised and written in the same transaction as a rating.
 * Discovery is one indexed lookup here and never an aggregate over `PlaceRatings`
 * — which is the whole of the scaling story (ADR-003 §8).
 */
entity PlaceStats : cuid {
  place    : Association to Places;
  /**
   * The two filter columns are copied here from `Places` on purpose. Discovery orders by
   * `score` and filters by cell and kind, and a read model that has to join to do that is
   * not a read model — the index `(geohash6, kind, score DESC)` on this one table answers
   * "the best restaurants near here" in a single range scan, and the place rows are then
   * fetched by id for the page that survived, never for the neighbourhood.
   */
  geohash6 : String(6);
  kind     : PlaceKind default 'other';
  /** Distinct households, which by the uniqueness rule is also the rating count. */
  ratings  : Integer default 0;
  starSum  : Integer default 0;
  s1       : Integer default 0;
  s2       : Integer default 0;
  s3       : Integer default 0;
  s4       : Integer default 0;
  s5       : Integer default 0;
  /** The plain mean, shown. One decimal is all anybody reads. */
  mean     : Decimal(3, 2) default 0;
  /**
   * The mean shrunk toward the global mean — what everything is ordered by, so a
   * single five-star rating cannot outrank forty at 4.6 (ADR-003 §6).
   */
  score    : Decimal(6, 4) default 0;
  /** How many published tips this place has, above the threshold. */
  tips     : Integer default 0;
  /** The commonest cost band, for the card. Null until anybody has said. */
  costBand : CostBand;
  changedAt : Timestamp;
}

/** Tag counts per place: the read model tag filtering orders by. */
entity PlaceTagCounts {
  key place : Association to Places;
  key tag   : String(24);
  count     : Integer default 0;
}

/**
 * A card in one of the decks — an activity or a gift idea. Seeded, and later
 * community-contributed. Not a place: a card says what to *do*, and may or may
 * not name somewhere to do it.
 */
entity Ideas : cuid {
  @mandatory
  title     : String(120);
  /** One sentence. What you would actually do. */
  summary   : String(240);
  deck      : String(20) enum {
    activity;
    gift;
  } default 'activity';
  kind      : PlaceKind default 'activity';
  costBand  : CostBand;
  /** Chips from the same vocabulary the ratings use. */
  tags      : String(200);
  /** Minutes, roughly, so an evening can be assembled without overrunning it. */
  minutes   : Integer;
  /** Seeded rows are curated and never withdrawn; contributed ones can be. */
  seeded    : Boolean default true;
  createdAt : Timestamp;
}


/* ------------------------------------------------------------------ *
 *  Cards   (TWM-ADR-004, CONTRACTS.md §16)
 *
 *  What a household has told the payment provider about, reduced to the
 *  handful of facts we are allowed to hold.
 *
 *  READ THIS BEFORE ADDING A COLUMN. There is no card number here, and there
 *  is no column a card number would fit in. That is deliberate and it is the
 *  entire security posture of the feature:
 *
 *    - `token` is the provider's handle. It is worthless to anybody without
 *      our secret API key, cannot be replayed against another merchant, and
 *      cannot be turned back into a card.
 *    - `last4`, `brand` and the expiry are what a bank app prints on its own
 *      cards screen — enough to tell two cards apart, not enough to be one.
 *    - `fingerprint` is the *provider's* hash, stored so that adding the same
 *      physical card twice is noticed. We do not compute it and cannot invert
 *      it.
 *
 *  A `pan`, `cvv`, `cardholderName` or `expiryFull` column added here would
 *  put every backup of this database, and every machine that has ever held
 *  one, into PCI DSS audit scope. If a feature seems to need one, the feature
 *  is wrong — see ADR-004 §3.
 * ------------------------------------------------------------------ */

/** How a setup ended. Mirrors `CardSetupOutcome` in srv/lib/payments/types.ts. */
type CardSetupStatus : String(12) enum {
  pending;
  succeeded;
  declined;
}

/**
 * One card a household has authorised for later use.
 *
 * Tenant-scoped like everything else a household owns. Rows are never deleted
 * on removal — `removedAt` is stamped instead — because "when did that card
 * stop being on file" is a question worth being able to answer, and the row
 * holds nothing sensitive enough to make keeping it a liability.
 */
@singular: 'PaymentMethod'
@plural  : 'PaymentMethods'
entity PaymentMethods : cuid, managed, tenant {
  /** The provider's handle for the card. Never a card number. */
  @mandatory
  token         : String(200);
  /** Which vault issued the token, so a provider switch cannot mix handles up. */
  @mandatory
  provider      : String(20);
  /** Visa, Mastercard, … Lower-case; see `CardBrand`. */
  brand         : String(20) default 'unknown';
  /** Four digits, as a string — leading zeros are real. */
  last4         : String(4);
  expMonth      : Integer;
  expYear       : Integer;
  /** The provider's stable hash of the underlying card. Used to spot duplicates. */
  fingerprint   : String(120);
  /** Cosmetic, from the issuer BIN table where the provider offers it. */
  issuer        : String(120);
  country       : String(2);
  /**
   * True when the issuer authenticated the cardholder while the card was being
   * stored. Under PSD2 this is what a later off-session charge relies on, so it
   * is evidence rather than decoration.
   */
  authenticated : Boolean default false;
  /** A name the household chose, e.g. "the joint one". Never the cardholder name. */
  label         : String(60);
  /** Exactly one per household, enforced in the handler. */
  isDefault     : Boolean default false;
  /** Set when removed; the row stays for the audit trail. */
  removedAt     : Timestamp null;
  /** Who added it, so a shared household can see whose card is on file. */
  addedBy       : Association to People;
}

/**
 * An attempt to add a card, from opening the form to whatever became of it.
 *
 * Separate from `PaymentMethods` because most attempts do not produce a card,
 * and the ones that fail are the interesting ones. It holds the provider's
 * reference so `finishCardSetup` can be re-asked safely — the flow has a gap in
 * the middle where the browser is away at the issuer, and a refresh, a lost
 * connection or a second tab must all be able to land on the same answer
 * instead of starting a second setup.
 *
 * Contains no card data, and by construction cannot: the only provider value in
 * it is a setup reference that expires.
 */
@singular: 'CardSetup'
@plural  : 'CardSetups'
entity CardSetups : cuid, managed, tenant {
  /** The provider's id for the setup. */
  @mandatory
  ref            : String(200);
  @mandatory
  provider       : String(20);
  status         : CardSetupStatus default 'pending';
  /** Written for a person, shown verbatim when a card is refused. */
  declineReason  : String(240);
  /** The card this produced, when it produced one. */
  paymentMethod  : Association to PaymentMethods null;
  startedBy      : Association to People;
  completedAt    : Timestamp null;
}


/* ------------------------------------------------------------------ *
 *  The ledger   (TWM-ADR-004, CONTRACTS.md §17)
 *
 *  Double-entry, in whole minor units, with no balance column anywhere.
 *
 *  READ THIS BEFORE ADDING A `balance` FIELD. A stored balance is a cache of
 *  a sum, and a cache that money depends on will one day disagree with the
 *  thing it caches — after a crash between two writes, after a retry that
 *  applied twice, after a migration that missed a row. When it does, nothing
 *  can say which of the two is right. A balance derived by summing postings
 *  cannot drift, because there is nothing for it to drift from. It costs one
 *  aggregate query. Pay it.
 *
 *  `amount` is `Integer` rather than the `Decimal(10,2)` CLAUDE.md specifies
 *  for money, and that is stricter rather than looser: a decimal still rounds
 *  when divided, and a ledger divides constantly. Integers force the rounding
 *  to be a decision somebody wrote down (`allocate()` in srv/lib/money/ledger)
 *  instead of something the database does quietly. `Expenses.amount` keeps its
 *  decimal — that column records what a receipt said, and a receipt is a
 *  decimal.
 * ------------------------------------------------------------------ */

/**
 * One balanced movement. Its postings sum to zero in every currency, which is
 * checked in `srv/lib/money/ledger.ts` before anything is written.
 */
@singular: 'LedgerTransfer'
@plural  : 'LedgerTransfers'
entity LedgerTransfers : cuid {
  /**
   * The caller's own idea of this movement, unique forever.
   *
   * Not a convenience. A provider delivers the same webhook twice, a phone
   * retries a request whose response was lost, a queue replays after a restart.
   * This column, and the unique index on it, are what make the second delivery
   * a no-op instead of a second transfer.
   */
  @mandatory
  idempotencyKey : String(120);
  /** What happened, in words, for the statement line and the audit. */
  reason         : String(120);
  at             : Timestamp @cds.on.insert: $now;
  postings       : Composition of many LedgerPostings
                     on postings.transfer = $self;
}

/** One side of a movement. Positive into the account, negative out of it. */
@singular: 'LedgerPosting'
@plural  : 'LedgerPostings'
entity LedgerPostings : cuid {
  transfer : Association to LedgerTransfers;
  /**
   * `household:<groupId>`, `external:points-treasury`, `fees:stripe`.
   *
   * Deliberately a string rather than an association to `Groups`. Accounts
   * outside this app — the world's side of a movement — have no group to point
   * at, and a nullable association that is null for half the rows is worse than
   * a well-formed key. `accountId()` is the only thing that spells one.
   */
  @mandatory
  account  : String(80);
  /** Whole minor units. See the block above for why this is not a Decimal. */
  @mandatory
  amount   : Integer64;
  /** ISO 4217, or 'PTS' for points. Accounts never mix currencies. */
  @mandatory
  currency : String(3);
  at       : Timestamp @cds.on.insert: $now;
}

/**
 * One award, so a daily cap can be applied and an act cannot pay twice.
 *
 * Separate from the ledger because the cap is a question about *acts* ("how
 * many places has this household rated today"), and answering it from postings
 * would mean parsing a reason string.
 */
@singular: 'PointsAward'
@plural  : 'PointsAwards'
entity PointsAwards : cuid, tenant {
  /** A key from EARN_RULES. Never an arbitrary string; the mint gate checks it. */
  @mandatory
  reason    : String(40);
  /** The act this paid for. Unique, so one act mints once however often it arrives. */
  @mandatory
  eventKey  : String(120);
  points    : Integer;
  /** Local date, for the per-day cap. */
  onDate    : Date;
  at        : Timestamp @cds.on.insert: $now;
}


/* ------------------------------------------------------------------ *
 *  Reflections   (CONTRACTS.md §18)
 *
 *  A private journal that writes something back.
 *
 *  THIS IS THE MOST PRIVATE TEXT IN THE APP and it is private in a way
 *  nothing else here is: not from the world, but from *the other people in
 *  the household*. A shared ledger is the point of this app; a shared journal
 *  would be a diary with the lock taken off.
 *
 *  So `author` is not decoration and not an audit column. It is the access
 *  rule: a row is readable by the person who wrote it and by nobody else,
 *  enforced in the handler on every read. The `tenant` aspect is here only so
 *  the row belongs somewhere and can be removed with a household — it is NOT
 *  the access boundary, and narrowing to the group alone would show two
 *  people each other's diaries.
 *
 *  One thing is stated here rather than only in the ADR, because it is a
 *  promise this app makes carefully elsewhere and deliberately breaks here:
 *  **the entry text IS sent to a language model.** That is the feature. Touch
 *  maps are never sent to a model (CONTRACTS §13.4); reflections are, and the
 *  screen says so before anybody writes a word. If that ever needs to change,
 *  it changes in the UI copy first.
 * ------------------------------------------------------------------ */

@singular: 'Reflection'
@plural  : 'Reflections'
entity Reflections : cuid, managed, tenant {
  /** What the person wrote. Never shown to anybody but them. */
  @mandatory
  entry      : LargeString;
  /** What was written back. Empty when no model was configured. */
  reply      : LargeString;
  /**
   * True when the safety check fired and a human-written response was shown
   * instead of a model's. Kept so the screen can render the entry the same way
   * it was first seen, and so nothing tries to "regenerate" a reply that was
   * never generated.
   */
  concerned  : Boolean default false;
  /** Which provider answered, or 'none'. Never a credential. */
  engine     : String(30);
  /**
   * The one person who may read this row. Enforced on every read.
   * Null only for rows written before a session could be resolved to a person,
   * which the handler treats as unreadable rather than as readable by all.
   */
  author     : Association to People;
}
