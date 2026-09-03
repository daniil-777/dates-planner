/**
 * LedgerService — the only service this app exposes (CONTRACTS.md §1.4).
 *
 * It is a thin OData V4 skin over `db/schema.cds`: every entity is a plain
 * projection so that the Fiori annotations in `db/annotations.cds` propagate
 * unchanged, and everything that is *not* CRUD is an explicit action or
 * function with a hand-written handler in `ledger-service.ts`.
 *
 * Three deliberate choices worth stating:
 *
 * 1. `Receipts.image` keeps its `@Core.MediaType` pairing, which is what turns
 *    it into a real OData media stream (`Receipts(<id>)/image`). Projecting the
 *    entity with `*` is enough — the annotations travel with the elements — so
 *    there is no second copy of them to keep in sync.
 * 2. `Expenses` gains one `virtual` element, `needsReview`. It is deliberately
 *    not a column — nothing would ever read it back, and a stored copy would go
 *    stale the moment a human touched the row — but the scan flow still has to
 *    tell the UI "this draft needs a human". A virtual element is exactly that:
 *    part of the API, never part of a table, ignored on writes. It is set on the
 *    draft returned by `scanReceipt`.
 * 3. `EventParticipants` is exposed next to `Events`, not hidden behind it. The
 *    link table is a composition, so an event can be written in one deep
 *    payload — but the UI also adds and removes a single person from an event
 *    that already exists, and that is one row, not a rewrite of the event.
 *
 * There is no debt in this service. Nothing here returns a balance, because
 * nobody owes anybody (CONTRACTS.md §9): `periodTotals` and `eventTotals` are
 * sums of what people *paid*, and the payment run closes a period rather than
 * squaring anyone up.
 */
using {twowaymatch as twm} from '../db/schema';
using from '../db/annotations';

service LedgerService @(path: '/api/ledger') {

  /* ---------------------------------------------------------------- data */

  /**
   * Postings, drafted and confirmed. `needsReview` is virtual: see the file
   * header — it is populated by `scanReceipt`, not stored.
   */
  entity Expenses          as projection on twm.Expenses {
    *,
    virtual null as needsReview : Boolean
  };

  /** Scanned images. `image` is a media stream; `mediaType` is its content type. */
  entity Receipts          as projection on twm.Receipts;

  entity Memories          as projection on twm.Memories;
  entity Photos            as projection on twm.Photos;

  /**
   * Pictures of an event (CONTRACTS.md §11.1). `image` is a media stream for
   * exactly the same reason `Receipts.image` is: the `@Core.MediaType` pairing
   * travels with the elements through a `*` projection, so `EventPhotos(<id>)/image`
   * serves the bytes and nothing has to be re-annotated here.
   */
  entity EventPhotos       as projection on twm.EventPhotos;

  /** Nudges before an event starts (CONTRACTS.md §11.2). */
  entity Reminders         as projection on twm.Reminders;
  entity Settlements       as projection on twm.Settlements;
  entity Statements        as projection on twm.Statements;
  entity Categories        as projection on twm.Categories;

  /** Everybody who can pay for something. Any number of rows (CONTRACTS.md §10). */
  entity People            as projection on twm.People;

  /** A trip, a dinner, a party. `participants` expands to the people on it. */
  entity Events            as projection on twm.Events;

  /** One person on one event. The key is the pair, so nobody joins twice. */
  entity EventParticipants as projection on twm.EventParticipants;

  entity Corrections       as projection on twm.Corrections;

  /** Mood readings — manual taps and camera detections alike. The photo is never stored. */
  entity Moods             as projection on twm.Moods;

  /**
   * The household's thread, and what has been said in it.
   *
   * `Messages` carries the media stream the same way `Receipts` and `EventPhotos` do, so a
   * voice note is fetched from `/api/ledger/Messages(<id>)/media` and never from a public
   * path. Writing a message goes through the `sendMessage` action rather than a plain
   * CREATE: the action is where the size, duration and mime limits live, and a raw insert
   * would walk straight past them.
   */
  entity Conversations     as projection on twm.Conversations;

  entity Messages          as projection on twm.Messages;

  /**
   * Touch maps — the most sensitive rows the service exposes (CONTRACTS.md §13).
   *
   * Read is household-wide on purpose: telling the person you sleep with what you like
   * is the entire feature, and a map only they could see would have no reader. Write is
   * not: `guardBodyMapWrite` refuses any insert or update that lands on somebody else's
   * map, so a roster nobody polices cannot be filled in on their behalf.
   */
  entity BodyMaps          as projection on twm.BodyMaps;

  entity BodyZones         as projection on twm.BodyZones;

  /* ------------------------------------------------------------- posting */

  /**
   * Post a draft: sets `status` to 'confirmed' and assigns the next
   * `documentNumber`. `predictedCategory` / `predictedMoment` are what the
   * model proposed *before* the human touched the row; when they differ from
   * what is finally stored, a `Corrections` row is written for the next
   * training round. Pass empty strings when there was no prediction.
   */
  action   confirmExpense(ID : UUID, predictedCategory : String, predictedMoment : String) returns Expenses;

  /* -------------------------------------------------------------- totals */

  /**
   * What one person paid, and what proportion of the total that is.
   *
   * `share` is a proportion for the bar in the UI — `paid / grandTotal`, never a
   * claim on anybody (CONTRACTS.md §9). A person who paid nothing in the window
   * still appears, with `paid: 0`: this is a roster, not a leaderboard.
   */
  type PersonTotal {
    personId : UUID;
    name     : String;
    /** Money, rounded once by `srv/lib/money.ts` — hence the fixed two decimals. */
    paid     : Decimal(10, 2);
    count    : Integer;
    /**
     * `paid / grandTotal`. Deliberately scale-free (`Scale="variable"` in the
     * EDMX): it is a ratio for a bar in the UI, not an amount, and pinning it to
     * four decimals would promise a rounding the arithmetic does not perform.
     */
    share    : Decimal;
  }

  /** Everything confirmed in one `YYYY-MM`, summed and attributed to its payers. */
  function periodTotals(period : String)                                                   returns {
    period     : String;
    grandTotal : Decimal(10, 2);
    count      : Integer;
    byPerson   : many PersonTotal;
  };

  /**
   * The same sum over one event's postings. `perHead` is
   * `grandTotal / participantCount`, shown as context ("CHF 254.60 each") and
   * never as an amount owed.
   */
  function eventTotals(eventId : UUID)                                                     returns {
    eventId          : UUID;
    name             : String;
    grandTotal       : Decimal(10, 2);
    perHead          : Decimal(10, 2);
    participantCount : Integer;
    count            : Integer;
    byPerson         : many PersonTotal;
  };

  /**
   * The monthly payment run, which is a **period close**: it records what the
   * period totalled, stamps a clearing document so the month can be marked done,
   * and links the lines it covered. It moves no money and computes no debt.
   */
  action   runSettlement(period : String)                                                  returns Settlements;

  /** Marks a closed period done and stamps when that happened. */
  action   markSettled(ID : UUID)                                                          returns Settlements;

  /** Period × category totals for the charts; both bounds are inclusive `YYYY-MM`. */
  function monthlyTotals(fromPeriod : String, toPeriod : String)                           returns array of {
    period   : String;
    category : String;
    total    : Decimal(10, 2);
  };

  /** Expenses that look like the same purchase booked twice. */
  function duplicates(ID : UUID)                                                           returns array of Expenses;

  /** Re-runs the two-head classifier over one expense and stores its verdict. */
  action   classify(ID : UUID)                                                             returns Expenses;

  /**
   * The whole scan pipeline in one call: normalise the image, store it, extract
   * it with Document AI, classify it, and return the draft expense it produced.
   */
  action   scanReceipt(image : LargeBinary, mediaType : String, fileName : String)         returns Expenses;

  /**
   * Look at a face and estimate the mood. Needs an LLM key (CONTRACTS.md §7); without one
   * it answers 501 and the UI keeps the manual picker. The image is analysed and discarded
   * — nothing is written by this action, saving the reading is the caller's separate POST.
   */
  action   detectMood(image : LargeBinary, mediaType : String)                             returns {
    level      : Integer;
    label      : String;
    confidence : Decimal;
    observation : String;
  };

  /** Writes (or rewrites) the yearly "Statement of Us". */
  action   generateStatement(year : Integer)                                               returns Statements;

  /* --------------------------------------------- photos, reminders, surprises */

  /**
   * Attach a photograph to an event (CONTRACTS.md §11.1).
   *
   * The bytes go through `srv/lib/images.ts` first — the same pipeline
   * `scanReceipt` uses, with the same 10 MB ceiling, the same EXIF strip, the
   * same 2000 px cap and the same JPEG q85 — so what is stored carries no GPS,
   * no device serial and no capture time. `takenOn` is the one piece of that
   * metadata worth keeping, and it is kept because a human typed it.
   */
  action   addEventPhoto(eventId : UUID, image : LargeBinary, mediaType : String, caption : String, takenOn : Date) returns EventPhotos;

  /** Remove one photograph. The event and everything else about it stay. */
  action   deleteEventPhoto(ID : UUID);

  /** Stamps `revealedAt`, which turns a surprise into an ordinary event (§11.3). */
  action   revealSurprise(ID : UUID)                                                       returns Events;

  /** A nudge `leadDays` before an event starts; `dueOn` is derived, never stored. */
  action   createReminder(eventId : UUID, leadDays : Integer, note : String)                returns Reminders;

  /** Ticks a reminder off. Idempotent: a second tap changes nothing. */
  action   completeReminder(ID : UUID)                                                     returns Reminders;

  /**
   * Say something. `kind` decides which of the remaining arguments matter:
   * `text` uses `body`; `audio` and `image` use `media`/`mediaType`, and audio also
   * carries `durationMs` and `peaks` — a JSON array of amplitudes captured while
   * recording, so a thread draws the waveform before fetching a byte of audio.
   */
  action   sendMessage(conversationId : UUID, kind : String, body : String, media : LargeBinary, mediaType : String, durationMs : Integer, peaks : String) returns Messages;

  /** The thread, newest last, with the author's name and colour already joined on. */
  function messages(conversationId : UUID, since : String)                                 returns array of {
    ID          : UUID;
    at          : Timestamp;
    kind        : String;
    body        : String;
    mediaType   : String;
    durationMs  : Integer;
    peaks       : String;
    authorId    : UUID;
    authorName  : String;
    authorColour : String;
    mine        : Boolean;
  };

  /** The one conversation this household talks in, created with the household. */
  function conversation()                                                                  returns {
    ID    : UUID;
    title : String;
  };

  /**
   * Everything the calendar needs for one window, in a single call.
   *
   * Both bounds are inclusive `YYYY-MM-DD`. Events land on every day they cover;
   * a reminder lands on its due day, `startsOn - leadDays`. A hidden surprise is
   * absent for everybody but the person who created it, and present for them with
   * `onlyYou` set — which is the whole reason this is one request and not one per
   * day: the answer depends on who is asking (CONTRACTS.md §11.3).
   */
  function upcoming(fromDate : String, toDate : String)                                    returns array of {
    /** `Events.ID` or `Reminders.ID` — the row this entry came from. */
    ID       : UUID;
    /** `event` or `reminder`. */
    kind     : String;
    /** The day this belongs on, `YYYY-MM-DD`. */
    date     : String;
    /** Last day of a multi-day event; null for a reminder and for a one-day event. */
    endsOn   : String;
    title    : String;
    place    : String;
    /** The event this entry is about — the same as `ID` when `kind` is `event`. */
    eventId  : UUID;
    /** True when this is a surprise only the person asking can see. */
    onlyYou  : Boolean;
    /** Reminders only: how many days before the event this fires. */
    leadDays : Integer;
    /** Reminders only: whether it has been ticked off. */
    done     : Boolean;
  };
}
