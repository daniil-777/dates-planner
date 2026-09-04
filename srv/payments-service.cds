/**
 * PaymentsService — adding and removing a card. TWM-ADR-004, CONTRACTS.md §16.
 *
 * Deliberately its own service on its own path rather than more actions on
 * `LedgerService`, for a reason that is about blast radius rather than tidiness:
 * this is the only route in the app that talks to a payment provider, and
 * keeping it addressable as one path means it can be rate-limited, logged and —
 * on the day somebody wants to — switched off, without touching anything else.
 *
 * Every operation is an action or a function. There is one read projection and
 * it is read-only: a card is created by completing a setup at the provider,
 * never by POSTing a row, and CAP would happily accept a POST to an exposed
 * entity. Removing the write paths removes the question.
 *
 * Nothing in this file, and nothing in the handler behind it, accepts a card
 * number. See `srv/lib/payments/pan.ts` for how that is enforced rather than
 * merely intended.
 */
using {twowaymatch as twm} from '../db/schema';

service PaymentsService @(path: '/api/payments') {

  /* ---------------------------------------------------------------- data */

  /**
   * The cards on file. Read-only, and already narrowed to the current
   * household and to rows that have not been removed.
   */
  @readonly
  entity Cards as projection on twm.PaymentMethods {
    ID,
    token,
    provider,
    brand,
    last4,
    expMonth,
    expYear,
    issuer,
    country,
    authenticated,
    label,
    isDefault,
    addedBy,
    createdAt
  } where removedAt is null;

  /* ------------------------------------------------------------- opening */

  /** What the browser needs to collect a card, and nothing more. */
  type StartedSetup {
    /** Echo back to `finishCardSetup`. */
    ref            : String(200);
    /**
     * The provider's browser-side credential for this one setup. Publishable by
     * design — it authorises one card onto one customer and expires.
     */
    clientSecret   : String(200);
    provider       : String(20);
    /** The provider's publishable key. Empty in mock mode. */
    publishableKey : String(200);
  }

  /**
   * Open a card setup.
   *
   * `label` is the household's own name for the card ("the joint one"), stored
   * only if the setup succeeds. It is not the cardholder name and must not be
   * used as one.
   */
  action startCardSetup(label : String(60)) returns StartedSetup;

  /** How a setup ended, in the terms the screen needs. */
  type SetupResult {
    status  : String(12);
    /** The card, when one was saved. */
    cardID  : UUID;
    brand   : String(20);
    last4   : String(4);
    /** Written for a person. Only set when `status` is 'declined'. */
    reason  : String(240);
    /** True when this card was already on file, so the screen can say so. */
    duplicate : Boolean;
  }

  /**
   * Ask what became of a setup. Safe to call repeatedly and from more than one
   * tab: the first call that finds a finished setup writes the card, the rest
   * read it back.
   */
  action finishCardSetup(ref : String(200)) returns SetupResult;

  /* ---------------------------------------------------------------- mock */

  /** One of the mock vault's scenarios, for the buttons that replace card fields. */
  type MockScenario {
    id     : String(20);
    label  : String(60);
    detail : String(200);
    brand  : String(20);
    last4  : String(4);
  }

  /**
   * The scenarios the mock vault offers. Returns an empty array whenever a real
   * provider is configured, which is what the front end keys off — there is no
   * separate "am I in mock mode" flag to get out of step with reality.
   */
  function mockScenarios() returns array of MockScenario;

  /**
   * Choose a mock outcome. Refuses outright unless the mock vault is the active
   * provider, so this cannot become a way to fabricate a card in production.
   */
  action chooseMockScenario(ref : String(200), scenario : String(20)) returns Boolean;

  /* ------------------------------------------------------------- keeping */

  /** Rename a card. The household's own label, never the cardholder's name. */
  action renameCard(ID : UUID, label : String(60)) returns Boolean;

  /** Make this the household's default. Clears the flag on every other card. */
  action makeDefaultCard(ID : UUID) returns Boolean;

  /**
   * Take a card off file. Detaches it at the provider first: a row removed here
   * while the token still lives there would leave a card charged by nothing and
   * visible in no screen.
   */
  action forgetCard(ID : UUID) returns Boolean;
}
