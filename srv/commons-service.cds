/**
 * CommonsService — the shared corpus of places (TWM-ADR-003, CONTRACTS.md §14).
 *
 * The second service this app exposes, and the only one whose rows are not somebody's
 * private data. It is deliberately shaped nothing like `LedgerService`.
 *
 * ## Functions, not entities
 *
 * `LedgerService` is a thin OData skin over the model: every entity is projected and CRUD
 * does the work. Here almost nothing is projected, and the reason is `PlaceRatings`.
 *
 * That table holds `authorKey`, which is the one column in the commons that connects a row
 * to a household. A projection of it — even `@readonly`, even with the column excluded —
 * would be one `$select` away from a mistake, and OData is very good at giving people
 * columns they asked for. So it is not exposed at all, in any shape. Discovery reads
 * `PlaceStats`, which is an aggregate with no author in it, and every read below is a
 * function returning exactly the fields it means to return.
 *
 * The rule, stated once: **nothing in this service ever returns an `authorKey`, and nothing
 * accepts one.** A caller's identity is derived from their session inside the handler and
 * never travels over the wire in either direction.
 *
 * ## No `scopeToGroup`
 *
 * Every entity in `LedgerService` is narrowed to the caller's household by one handler.
 * Nothing here is, because nothing here has a `group` column to narrow on — that is the
 * definition of the commons. This service must therefore never be given a tenant entity to
 * project; if one is ever needed, it belongs in `LedgerService` instead.
 */
using {twowaymatch as twm} from '../db/schema';

service CommonsService @(path: '/api/commons') {

  /* ----------------------------------------------------------------- types */

  /** What a place looks like in a list or on a pin. Everything a card needs, and nothing else. */
  type PlaceCard {
    ID          : UUID;
    name        : String(200);
    kind        : String(20);
    lat         : Double;
    lon         : Double;
    city        : String(120);
    /** Metres from the point the caller asked about. Null when they asked about nowhere. */
    distance    : Integer;
    /** The plain mean, to two decimals. Null until the place is publishable. */
    stars       : Decimal(3, 2);
    /** How many households are behind that number. Shown; it is the honest denominator. */
    households  : Integer;
    /** True once enough households have rated it to show anything at all (§14.1). */
    published   : Boolean;
    /** How many more households are needed. Zero once it is published. */
    needs       : Integer;
    costBand    : String(12);
    /** The commonest chips, most-agreed first. */
    tags        : array of String(24);
    /** Deep links out. Google and Apple are destinations, never stores (ADR-003 §2). */
    googleUrl   : String(300);
    appleUrl    : String(300);
  }

  /** One published tip. Carries no author, no date precise enough to place anybody. */
  type PlaceTip {
    text : String(240);
    tags : array of String(24);
  }

  /**
   * An evening: somewhere to eat and something to do, with what it costs one person.
   *
   * Always dealt three at a time. One suggestion is an instruction; three is a choice
   * (ADR-003 §9).
   */
  type EveningCard {
    /** Stable for the day and the household, so the deck does not reshuffle under a thumb. */
    ID       : String(64);
    eat      : PlaceCard;
    /** A place to go, when the corpus has one nearby. */
    doPlace  : PlaceCard;
    /** An idea from the deck, used when it does not. Exactly one of these two is set. */
    doIdea   : {
      ID       : UUID;
      title    : String(120);
      summary  : String(240);
      costBand : String(12);
      minutes  : Integer;
    };
    /** The two cost bands added together, as a band. */
    costBand : String(12);
    /** One line saying why this pairing, in the corpus's own words. */
    because  : String(200);
  }

  /* ------------------------------------------------------------------ read */

  /**
   * Places near a point, best first.
   *
   * "Best" is the Bayesian score, never the raw mean (§14.3). Keyset pagination: pass the
   * `cursor` from the previous page back, never an offset — an offset re-reads every row it
   * skips, and at a million places that is the whole table by page fifty.
   */
  function nearby(lat      : Double,
                  lon      : Double,
                  radiusM  : Integer,
                  kind     : String(20),
                  tag      : String(24),
                  limit    : Integer,
                  cursor   : String(120)) returns {
    items  : array of PlaceCard;
    /** Pass back as `cursor` for the next page. Null when there is no next page. */
    next   : String(120);
  };

  /** One place, with its chips and — above the threshold — its tips. */
  function placeDetail(ID : UUID) returns {
    place      : PlaceCard;
    histogram  : array of Integer;
    tips       : array of PlaceTip;
    /** True when the caller's own household has already rated this place. */
    ratedByYou : Boolean;
    /** What they said, so the sheet opens on their answer rather than empty. */
    yourStars  : Integer;
  };

  /** Three evenings, for a point and an optional ceiling on what it may cost each. */
  function tonight(lat     : Double,
                   lon     : Double,
                   maxCost : String(12)) returns array of EveningCard;

  /** The gift and activity decks. Cards that need no place. */
  function deck(name : String(20)) returns array of {
    ID       : UUID;
    title    : String(120);
    summary  : String(240);
    costBand : String(12);
    minutes  : Integer;
    tags     : array of String(24);
  };

  /* ----------------------------------------------------------------- write */

  /**
   * Rate a place, creating it in the corpus if this is the first anybody has heard of it.
   *
   * One rating per household per place: rating again amends the first rather than adding a
   * second, so a place cannot be pushed up the list by one enthusiastic household. Pass
   * `placeID` for somewhere already in the corpus, or the name and coordinates for somewhere
   * new.
   */
  action rate(placeID  : UUID,
              name     : String(200),
              kind     : String(20),
              lat      : Double,
              lon      : Double,
              city     : String(120),
              country  : String(2),
              osmType  : String(10),
              osmId    : String(24),
              stars    : Integer,
              costBand : String(12),
              tags     : array of String(24),
              tip      : String(240)) returns PlaceCard;

  /** Take a household's own rating back. The place stays; their row and its weight go. */
  action withdrawRating(placeID : UUID) returns PlaceCard;

  /**
   * Report a tip. Hides it immediately and everywhere, pending nothing.
   *
   * Hidden rather than deleted: the rating and its stars are somebody's honest opinion even
   * when the sentence attached to it is not, and deleting the row would quietly change the
   * score of a place because somebody objected to a word in it.
   */
  action reportTip(placeID : UUID, reason : String(200)) returns Boolean;
}
