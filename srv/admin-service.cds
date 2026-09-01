/**
 * AdminService — the three operations that touch the classifier rather than the ledger.
 *
 * This is the model's control panel: what is deployed (`modelInfo`), pick up new weights
 * without a restart (`reloadModel`), and train a new pair of heads from the corrections
 * two humans have made since (`retrain`).
 *
 * It exposes no entities on purpose. Everything readable lives in LedgerService; adding a
 * second door to the same data would only double the surface that has to stay correct.
 *
 * `@requires: 'admin'` is a departure from docs/AUTH_BTP.md §2, which argues — rightly,
 * for the ledger — that a role hierarchy between people who share a bank account is
 * theatre. These three are different: `retrain` spawns a process and rewrites the model
 * every prediction in the app comes from, so it is worth one more deliberate step than
 * tapping a row in a list. In production both configured logins carry the role
 * (srv/server.ts); in development CAP's mocked users mean you have to sign in as one of
 * the users that has it, which is the point.
 */
@requires: 'admin'
service AdminService @(path: '/api/admin') {

  /** Accuracy on the held-out split of the run that produced the deployed weights. */
  type ModelMetrics {
    categoryAccuracy : Decimal;
    momentF1         : Decimal;
  }

  /** The metadata block of `ml/model/weights.json` (docs/CONTRACTS.md §3). */
  type ModelInfo {
    /** False when no model has been exported yet; every other field is then empty. */
    present         : Boolean;
    /** Where the file was looked for, so a `false` above is actionable. */
    path            : String;
    /** Format version of weights.json, not of the app. */
    version         : Integer;
    /** Hashing-trick bucket count. Must match `ml/train.py --n-buckets`. */
    nBuckets        : Integer;
    /** Local wall-clock ISO stamp, no timezone suffix — as Python wrote it. */
    trainedAt       : String;
    trainedRows     : Integer;
    metrics         : ModelMetrics;
    /** The seven dense features, in contract order (docs/CONTRACTS.md §2.4). */
    numericFeatures : array of String;
    /** Category head labels, ascending; the row index in the coefficient matrix. */
    categoryLabels  : array of String;
    /** Moment head labels, ascending. */
    momentLabels    : array of String;
    /** Size of the weights file on disk, which is mostly base64 coefficients. */
    fileBytes       : Integer64;
    /** Last write to the file, as an ISO timestamp — the reload cache key. */
    fileModifiedAt  : String;
  }

  /** What a long-running job hands back the instant it is started. */
  type JobNote {
    /** False when a run was already in flight; `note` says so. */
    started : Boolean;
    note    : String;
    /** Path of the training log to tail, relative to the project root. */
    logFile : String;
  }

  /**
   * Drop the cached weights so the next `classify()` reads `ml/model/weights.json` from
   * disk again (docs/CONTRACTS.md §5). Cheap, synchronous, and the thing to call after
   * copying a new model onto a running server by hand.
   */
  action reloadModel() returns String;

  /** What is deployed right now. Reads the file, never the in-memory cache. */
  function modelInfo() returns ModelInfo;

  /**
   * Start `npm run ml:retrain` in the background and return immediately.
   *
   * The pipeline — export the live ledger, train both heads, export the weights, run the
   * parity test — takes minutes, which is far longer than an OData request should live.
   * Progress goes to the log named in the response.
   */
  action retrain() returns JobNote;
}
