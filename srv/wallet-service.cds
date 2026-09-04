/**
 * WalletService — points, and what they turn into. TWM-ADR-004, CONTRACTS.md §17.
 *
 * There is no entity in this service, only functions and actions, and that is
 * the design rather than an omission. A points balance is a *sum of postings*,
 * never a row — exposing an entity would invite somebody to write one.
 *
 * Nothing here can mint points. Awards happen server-side, in `after` handlers
 * attached to the services where the acts actually occur, so a client cannot
 * ask to be paid. The only write a client can make is spending what it has.
 */
service WalletService @(path: '/api/wallet') {

  /** One line of the history. */
  type PointsEntry {
    at     : Timestamp;
    /** The human label from EARN_RULES, or 'Converted points'. */
    reason : String(120);
    points : Integer;
  }

  /** Everything the wallet screen needs, in one round trip. */
  type Wallet {
    /** The household's points. A derived sum; there is no column behind it. */
    balance        : Integer;
    /** Earned all time, so the screen can show a total that only ever goes up. */
    earned         : Integer;
    /** What the balance is worth in minor units, rounded down. */
    worth          : Integer;
    currency       : String(3);
    /** Named rather than numbered: 'Worth listening to', not 'level 4'. */
    standing       : String(40);
    /** Points at the next rung, or null at the top. */
    nextStanding   : Integer;
    /** How far into the current rung, 0–1, for the progress arc. */
    into           : Decimal(5, 4);
    /** Below this, converting is not offered. */
    minimum        : Integer;
    /** Points per minor unit. */
    rate           : Integer;
    /** Whether converting is available at all on this deployment. */
    canConvert     : Boolean;
    /** Why not, when it is not. Written for a person. */
    cannotConvert  : String(200);
    recent         : array of PointsEntry;
  }

  function wallet() returns Wallet;

  /** Every way to earn, so the screen can show what is worth doing. */
  type EarnWay {
    reason : String(40);
    label  : String(60);
    points : Integer;
    perDay : Integer;
    /** How many of today's allowance is left. */
    left   : Integer;
  }

  function waysToEarn() returns array of EarnWay;

  /** What a conversion would do, without doing it. */
  action previewConversion(points : Integer) returns {
    ok     : Boolean;
    reason : String(200);
    /** Minor units. */
    value  : Integer;
  };

  /**
   * Spend points.
   *
   * Burns the points and records what is owed. It deliberately does **not**
   * pay anybody: paying requires something that holds money, which this app
   * does not have and must not pretend to (ADR-004 §7). The redemption is
   * recorded and settled out of band.
   */
  action convertPoints(points : Integer) returns {
    ok     : Boolean;
    reason : String(200);
    value  : Integer;
    /** The balance afterwards, so the screen need not re-read. */
    balance : Integer;
  };
}
