/// <reference types="@cap-js/cds-types" />
/**
 * AdminService — the model's control panel, plus the nightly job that keeps it current.
 *
 * The continuous-learning loop this app is built around is: predict → a human disagrees →
 * the disagreement is logged in `Corrections` → the next training round learns from it.
 * `scripts/export-training-data.ts` turns those corrections into a CSV, `ml/train.py`
 * fits the two heads, `ml/export_ts.py` writes `ml/model/weights.json`, and
 * `test/classifier-parity.test.ts` proves the TypeScript port still agrees with Python.
 * `npm run ml:retrain` is all four in a row; this file is what starts it — on demand from
 * `retrain()`, and unattended at 03:00 when enough new rows have accumulated to be worth
 * the CPU.
 *
 * Nothing here trains anything in-process. Training is Python's job, it takes minutes, and
 * doing it inside the event loop would freeze the ledger for everybody using it.
 */
import cds from '@sap/cds'
import cron from 'node-cron'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { reloadModel } from './lib/classifier'
// Relative rather than '#cds-models/twowaymatch': package.json carries no "imports"
// mapping for that subpath, so the alias resolves at neither compile nor run time.
import { Expenses } from '../@cds-models/twowaymatch'

const LOG = cds.log('admin')

const WEIGHTS_PATH = join(cds.root, 'ml', 'model', 'weights.json')
const RETRAIN_LOG = join(cds.root, 'logs', 'retrain.log')

/** 03:00 local. Late enough that nobody is posting a receipt, early enough to be done by breakfast. */
const NIGHTLY_SCHEDULE = '0 3 * * *'

/**
 * How many newly confirmed expenses justify a retraining run.
 *
 * Below this the run costs minutes of CPU to move a decision boundary by nothing: the
 * model already sees thousands of rows, and nineteen more will not change a coefficient
 * anyone would notice. Twenty is roughly a fortnight of a household's spending, so in
 * practice this fires every week or two rather than every night.
 */
const RETRAIN_THRESHOLD = 20

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/* ------------------------------------------------------------------ *
 *  Shapes returned to the client — see srv/admin-service.cds
 * ------------------------------------------------------------------ */

interface ModelMetrics {
  categoryAccuracy: number | null
  momentF1: number | null
}

interface ModelInfo {
  present: boolean
  path: string
  version: number | null
  nBuckets: number | null
  trainedAt: string | null
  trainedRows: number | null
  metrics: ModelMetrics
  numericFeatures: string[]
  categoryLabels: string[]
  momentLabels: string[]
  fileBytes: number | null
  fileModifiedAt: string | null
}

interface JobNote {
  started: boolean
  note: string
  logFile: string
}

/* ------------------------------------------------------------------ *
 *  The service
 * ------------------------------------------------------------------ */

export default class AdminService extends cds.ApplicationService {
  override async init(): Promise<void> {
    this.on('reloadModel', () => handleReloadModel())
    this.on('modelInfo', () => readModelInfo())
    this.on('retrain', () => startRetrain('requested by an admin'))

    scheduleNightlyRetrain()

    await super.init()
  }
}

function handleReloadModel(): string {
  reloadModel()
  const info = readModelInfo()
  LOG.info('classifier weights cache dropped; next classify() reads from disk')
  return info.present
    ? `weights cache dropped — ${relative(cds.root, WEIGHTS_PATH)} (trained ${
        info.trainedAt ?? 'at an unknown time'
      }, ${info.trainedRows ?? 0} rows) will be read on the next classify()`
    : `weights cache dropped, but ${relative(cds.root, WEIGHTS_PATH)} does not exist — ` +
        'run `npm run ml:retrain` before expecting a prediction'
}

/* ------------------------------------------------------------------ *
 *  modelInfo
 * ------------------------------------------------------------------ */

/**
 * The metadata block of `weights.json`, read fresh from disk every time.
 *
 * Deliberately not cached: the one question this answers is "what is actually on disk
 * right now", usually asked immediately after a retrain, and a cache would make it lie at
 * exactly the moment it matters. The file is ~5 MB, which is a slow read by the standards
 * of this app and an irrelevant one by the standards of an admin console nobody opens
 * twice a minute. The coefficients themselves are never touched — only the header fields.
 */
function readModelInfo(): ModelInfo {
  const empty: ModelInfo = {
    present: false,
    path: relative(cds.root, WEIGHTS_PATH),
    version: null,
    nBuckets: null,
    trainedAt: null,
    trainedRows: null,
    metrics: { categoryAccuracy: null, momentF1: null },
    numericFeatures: [],
    categoryLabels: [],
    momentLabels: [],
    fileBytes: null,
    fileModifiedAt: null,
  }

  let raw: unknown
  let stats: { size: number; mtime: Date }
  try {
    stats = statSync(WEIGHTS_PATH)
    raw = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf8'))
  } catch (error) {
    LOG.warn('no readable model at', empty.path, '-', describe(error))
    return empty
  }

  const file = asRecord(raw)
  const metrics = asRecord(file.metrics)
  const heads = asRecord(file.heads)

  return {
    ...empty,
    present: true,
    version: asNumber(file.version),
    nBuckets: asNumber(file.nBuckets),
    trainedAt: asString(file.trainedAt),
    trainedRows: asNumber(file.trainedRows),
    metrics: {
      categoryAccuracy: asNumber(metrics.categoryAccuracy),
      momentF1: asNumber(metrics.momentF1),
    },
    numericFeatures: asStrings(file.numericFeatures),
    categoryLabels: asStrings(asRecord(heads.category).labels),
    momentLabels: asStrings(asRecord(heads.moment).labels),
    fileBytes: stats.size,
    fileModifiedAt: stats.mtime.toISOString(),
  }
}

/* ------------------------------------------------------------------ *
 *  retrain
 * ------------------------------------------------------------------ */

/** At most one training run at a time: two would fight over `ml/model/weights.json`. */
let running: ChildProcess | null = null

/**
 * Spawn `npm run ml:retrain` and return before it has done anything.
 *
 * The child is detached from the request in every way that matters: its output goes
 * straight to a file descriptor on the training log rather than through a pipe this
 * process would have to keep draining, and the response is written the moment the process
 * exists. An OData action that waited for this would time out somewhere in the middle of
 * scikit-learn's second head.
 */
function startRetrain(trigger: string): JobNote {
  const logFile = relative(cds.root, RETRAIN_LOG)

  if (running !== null) {
    return {
      started: false,
      note: `a retraining run is already in flight (pid ${running.pid ?? 0}) — tail ${logFile}`,
      logFile,
    }
  }

  mkdirSync(dirname(RETRAIN_LOG), { recursive: true })
  note(`retrain started (${trigger})`)

  // A file descriptor rather than a pipe: `npm run ml:retrain` prints a training log's
  // worth of output, and a pipe nobody reads fills its buffer and blocks the child.
  const fd = openSync(RETRAIN_LOG, 'a')
  let child: ChildProcess
  try {
    child = spawn(npm, ['run', 'ml:retrain'], {
      cwd: cds.root,
      stdio: ['ignore', fd, fd],
      env: process.env,
    })
  } catch (error) {
    closeSync(fd)
    const reason = describe(error)
    note(`retrain could not start: ${reason}`)
    return { started: false, note: `could not start npm run ml:retrain: ${reason}`, logFile }
  }

  running = child

  /**
   * Release the log descriptor and the in-flight slot, exactly once.
   *
   * A failure to spawn emits **both** events: `'error'` with the ENOENT, and then `'close'`
   * with code -2. Closing `fd` in each handler therefore closes it twice, and the second
   * `closeSync` throws EBADF from inside an event handler — an uncaught exception that
   * takes the whole server down on the one code path that only runs when something is
   * already wrong. Worse than the crash: once the number is free, an unrelated file opened
   * in between owns it, and the second close would shut *that*.
   */
  let settled = false
  const settle = (): boolean => {
    if (settled) return false
    settled = true
    closeSync(fd)
    running = null
    return true
  }

  child.on('error', error => {
    if (!settle()) return
    note(`retrain failed to run: ${describe(error)}`)
    LOG.error('retrain failed to run:', describe(error))
  })

  child.on('close', code => {
    if (!settle()) return
    if (code === 0) {
      note('retrain finished; dropping the weights cache so the new model is served')
      // Without this the server keeps scoring against the weights it loaded at startup,
      // and the whole run would only take effect on the next restart.
      reloadModel()
      LOG.info('retrain finished; classifier weights reloaded')
    } else {
      note(`retrain exited ${code ?? -1} — the parity test or the trainer failed, see above`)
      LOG.warn(`retrain exited ${code ?? -1}; the deployed model is unchanged`)
    }
  })

  return {
    started: true,
    note:
      `retraining in the background (pid ${child.pid ?? 0}): export the ledger, fit both ` +
      `heads, export the weights, run the parity test. Progress goes to ${logFile}; the ` +
      'model reloads itself when the run succeeds.',
    logFile,
  }
}

/* ------------------------------------------------------------------ *
 *  The nightly job
 * ------------------------------------------------------------------ */

let scheduled = false

/**
 * Retrain at 03:00, but only when there is something new to learn from.
 *
 * The guard is the whole point. Retraining every night regardless would burn CPU on a
 * dataset that has not moved, and — worse — would rewrite `weights.json` (and so every
 * confidence the UI shows) for no reason. `newConfirmedRows` counts what the model has
 * genuinely not seen; below `RETRAIN_THRESHOLD` the job logs why it did nothing, which is
 * the line you want in the log at 09:00 when you wonder whether cron is even running.
 *
 * Never scheduled under test: a vitest run must not spawn `npm run ml:retrain`, and a
 * registered cron task keeps a timer alive that would hold the process open.
 */
function scheduleNightlyRetrain(): void {
  if (scheduled) return
  if (isTestRun()) {
    LOG.info('nightly retraining not scheduled (test profile)')
    return
  }

  cron.schedule(NIGHTLY_SCHEDULE, () => void nightlyRetrain(), {
    name: 'twoway-nightly-retrain',
    // A run that overlaps the previous one would have two trainers writing one file.
    noOverlap: true,
    // The HTTP server keeps the process alive; this timer should not be what does.
    unref: true,
  })
  scheduled = true
  LOG.info(`nightly retraining scheduled at ${NIGHTLY_SCHEDULE} (>= ${RETRAIN_THRESHOLD} new rows)`)
}

async function nightlyRetrain(): Promise<void> {
  try {
    const info = readModelInfo()
    const backlog = await newConfirmedRows(info)

    if (backlog.newRows < RETRAIN_THRESHOLD) {
      note(
        `nightly check: ${backlog.newRows} new confirmed row(s) since ${
          info.trainedAt ?? 'the beginning'
        } (${backlog.totalConfirmed} confirmed in total) — under the threshold of ` +
          `${RETRAIN_THRESHOLD}, not retraining`,
      )
      return
    }

    const job = startRetrain(
      `nightly: ${backlog.newRows} new confirmed rows since ${info.trainedAt ?? 'the beginning'}`,
    )
    if (!job.started) LOG.warn('nightly retrain skipped:', job.note)
  } catch (error) {
    note(`nightly check failed: ${describe(error)}`)
    LOG.error('nightly retrain check failed:', describe(error))
  }
}

interface Backlog {
  totalConfirmed: number
  sinceTrainedAt: number
  newRows: number
}

/**
 * How many confirmed expenses the deployed model has never been trained on.
 *
 * Two measures, because neither is trustworthy alone.
 *
 * `sinceTrainedAt` compares `Expenses.createdAt` with `weights.json`'s `trainedAt`. That
 * needs a conversion: Python writes a **local wall-clock** stamp with no timezone suffix
 * (`ml/export_ts.py` uses `datetime.now().isoformat()`), while CAP stores timestamps as
 * ISO-8601 in UTC. Comparing the two strings directly would be off by the local offset —
 * an hour or two of expenses, twice a year, silently. `new Date(...)` reads a suffix-less
 * stamp as local time, which is exactly the right reading here.
 *
 * `trainedRows` is the second measure, and it only means anything once the model has been
 * trained from the live ledger: the shipped weights were fitted on 4 000 synthetic rows,
 * so `totalConfirmed - trainedRows` is deeply negative and says nothing. It is used only
 * when positive, where it catches the case of a `weights.json` copied in from elsewhere
 * with a `trainedAt` in the future.
 */
async function newConfirmedRows(info: ModelInfo): Promise<Backlog> {
  const totalConfirmed = await countConfirmed()

  let sinceTrainedAt = totalConfirmed
  if (info.trainedAt !== null) {
    const trainedAtUtc = new Date(info.trainedAt)
    if (!Number.isNaN(trainedAtUtc.getTime())) {
      sinceTrainedAt = await countConfirmed(trainedAtUtc.toISOString())
    }
  }

  const byRowCount = info.trainedRows === null ? 0 : totalConfirmed - info.trainedRows
  return {
    totalConfirmed,
    sinceTrainedAt,
    newRows: Math.max(sinceTrainedAt, byRowCount > 0 ? byRowCount : 0),
  }
}

async function countConfirmed(createdAfter?: string): Promise<number> {
  const where =
    createdAfter === undefined
      ? { status: 'confirmed' }
      : { status: 'confirmed', createdAt: { '>': createdAfter } }

  const rows = (await SELECT.from(Expenses).columns('ID').where(where)) as unknown as {
    ID: string
  }[]
  return rows.length
}

/* ------------------------------------------------------------------ *
 *  The training log
 * ------------------------------------------------------------------ */

/**
 * One timestamped line in `logs/retrain.log`, which is also where the child's stdout and
 * stderr go — so the file reads as one story: why a run started, what the trainer said,
 * and how it ended.
 *
 * Best-effort by design. A read-only volume must not be able to take down an admin action
 * or a cron tick.
 */
function note(line: string): void {
  try {
    mkdirSync(dirname(RETRAIN_LOG), { recursive: true })
    appendFileSync(RETRAIN_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch (error) {
    LOG.warn('could not write the training log:', describe(error))
  }
}

/* ------------------------------------------------------------------ *
 *  Small helpers
 * ------------------------------------------------------------------ */

function isTestRun(): boolean {
  return process.env.NODE_ENV === 'test' || cds.env.profiles.includes('test')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
