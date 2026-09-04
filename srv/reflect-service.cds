/**
 * ReflectService — a private journal that writes something back.
 * CONTRACTS.md §18.
 *
 * Its own service and its own path for the same reason payments has one: this
 * is the only route in the app carrying text nobody else in the household may
 * read, and keeping it addressable as one path means it can be reasoned about,
 * rate-limited and — if it ever needs to be — switched off on its own.
 *
 * There is no entity here. A reflection is created by writing one and read
 * back through a function that filters to the author; exposing the table would
 * hand CAP a generic read path that the author check would have to be bolted
 * onto, and a bolted-on access rule is one somebody removes by accident.
 */
service ReflectService @(path: '/api/reflect') {

  type Helpline {
    name    : String(60);
    contact : String(60);
    detail  : String(200);
  }

  type Reflection {
    ID        : UUID;
    at        : Timestamp;
    entry     : String;
    reply     : String;
    /** True when a person's help was offered instead of a model's reply. */
    concerned : Boolean;
    helplines : array of Helpline;
  }

  /**
   * Write something down.
   *
   * Answers with the reply, so the screen makes one round trip rather than
   * writing and then polling for an answer.
   */
  action reflect(entry : String) returns Reflection;

  /** This person's own entries, newest first. Never anybody else's. */
  function myReflections(limit : Integer) returns array of Reflection;

  /** Take one back. Removes the row outright — a journal with an undo is a journal. */
  action forgetReflection(ID : UUID) returns Boolean;

  /** Whether a model is configured, so the screen can be honest before anybody types. */
  function reflectAvailable() returns {
    available : Boolean;
    /** The provider name, for the settings line. Never a credential. */
    engine    : String(30);
  };
}
