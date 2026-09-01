/**
 * Loading and scoring `ml/model/weights.json` (CONTRACTS §3 and §2.5).
 *
 * The file is 4.7 MiB of base64 float32, so two things matter here:
 *
 * 1. **Nothing happens at import time.** `require`-ing the classifier — which a
 *    CAP handler does just by existing — must not read five megabytes off disk
 *    or spend the CPU decoding it. The weights are read on the first
 *    `classifyLocal()` call and cached from then on; `clearModelCache()` drops
 *    them so a freshly retrained model can be picked up without a restart.
 * 2. **The decode is checked, not trusted.** A weights file whose numeric block,
 *    label count or coefficient width disagrees with this code would still
 *    score — just wrongly, and silently. `ml/predict.py` performs exactly the
 *    same checks; this is the TypeScript half of that guard.
 *
 * Arithmetic is done in doubles on both sides. Python widens the decoded float32
 * coefficients to float64 before scoring precisely because that is what
 * JavaScript does when it reads a `Float32Array` element into a `number`: the
 * stored values stay float32-exact, the sums are computed in double precision,
 * and the two languages agree well inside the 1e-4 the parity test allows.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { N_NUMERIC, NUMERIC_FEATURE_NAMES, numericFeatures, textFeatures } from './features'

/** One label and its probability. */
export interface Scored {
  label: string
  p: number
}

/** The classifier's answer for one transaction (CONTRACTS §5). */
export interface ClassifyResult {
  category: string
  categoryConfidence: number
  categoryTop3: Scored[]
  moment: string
  momentConfidence: number
  momentTop3: Scored[]
  engine: 'local' | 'remote'
}

/** Raised when `weights.json` is missing, unreadable, or not the shape §3 promises. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelError'
  }
}

/** One softmax head: labels aligned row-for-row with the coefficient matrix. */
export interface Head {
  labels: string[]
  intercept: Float64Array
  /** Row-major, `rows * columns` float32 values. */
  coef: Float32Array
  rows: number
  columns: number
}

export interface LoadedModel {
  nBuckets: number
  numericNames: string[]
  mean: Float64Array
  scale: Float64Array
  heads: { category: Head; moment: Head }
  trainedAt: string
  trainedRows: number
  metrics: Record<string, number>
  /** Absolute path the weights were read from — surfaced in error messages only. */
  path: string
}

/** Both heads the app scores. A third head would need a contract change first. */
const HEAD_NAMES = ['category', 'moment'] as const

const WEIGHTS_RELATIVE_PATH = join('ml', 'model', 'weights.json')

/** How far up from this module to look for the repo root before giving up. */
const MAX_ANCESTORS = 8

let cached: LoadedModel | null = null

/**
 * Locate `ml/model/weights.json` by walking up from this module.
 *
 * WHY not a path relative to `process.cwd()`: vitest, `cds watch`, `cds-serve`
 * and a `scripts/` one-shot all start in different directories. WHY not a fixed
 * `../../../` either: the same source is executed from `srv/` under `cds-tsx`
 * and from `gen/srv/` after `cds build`, which are different depths. Walking up
 * for the marker file is the one form that survives both.
 */
function resolveWeightsPath(): string {
  let directory = __dirname
  for (let step = 0; step <= MAX_ANCESTORS; step += 1) {
    const candidate = join(directory, WEIGHTS_RELATIVE_PATH)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new ModelError(
    `${WEIGHTS_RELATIVE_PATH} not found above ${resolve(__dirname)} — ` +
      'run "npm run ml:train" then "npm run ml:export"',
  )
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelError(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ModelError(`${what} must be a string`)
  return value
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ModelError(`${what} must be a finite number`)
  }
  return value
}

function asNumberArray(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new ModelError(`${what} must be an array`)
  return value.map((entry, index) => asNumber(entry, `${what}[${index}]`))
}

function asStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new ModelError(`${what} must be an array`)
  return value.map((entry, index) => asString(entry, `${what}[${index}]`))
}

/**
 * Decode a base64 block of little-endian float32 into a `Float32Array`.
 *
 * Read through a `DataView` with an explicit `littleEndian` flag rather than
 * aliasing the buffer with `new Float32Array(bytes.buffer)`: that shortcut needs
 * the decoded bytes to start at a 4-byte-aligned offset (`Buffer.from` pools
 * small allocations and does not promise one) *and* it silently produces
 * byte-swapped garbage on a big-endian host. `export_ts.py` writes `'<f4'`;
 * this reads `'<f4'`.
 */
function decodeFloat32(base64: string, expected: number, what: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength !== expected * 4) {
    const decoded = Math.floor(bytes.byteLength / 4)
    throw new ModelError(`${what}: coefB64 decodes to ${decoded} floats, expected ${expected}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const values = new Float32Array(expected)
  for (let index = 0; index < expected; index += 1) {
    values[index] = view.getFloat32(index * 4, true)
  }
  return values
}

function decodeHead(raw: unknown, name: string, columns: number): Head {
  const head = asRecord(raw, `head ${name}`)
  const shape = asNumberArray(head.shape, `head ${name}: shape`)
  if (shape.length !== 2) throw new ModelError(`head ${name}: shape must be [rows, columns]`)
  const rows = shape[0]
  if (shape[1] !== columns) {
    throw new ModelError(
      `head ${name}: ${shape[1]} coefficient columns, expected nBuckets + numeric = ${columns}`,
    )
  }
  if (!Number.isInteger(rows) || rows < 2) {
    throw new ModelError(`head ${name}: ${rows} coefficient rows, expected at least 2`)
  }
  const labels = asStringArray(head.labels, `head ${name}: labels`)
  if (labels.length !== rows) {
    throw new ModelError(`head ${name}: ${labels.length} labels for ${rows} coefficient rows`)
  }
  const intercept = asNumberArray(head.intercept, `head ${name}: intercept`)
  if (intercept.length !== rows) {
    throw new ModelError(`head ${name}: ${intercept.length} intercepts for ${rows} rows`)
  }
  const coefB64 = asString(head.coefB64, `head ${name}: coefB64`)
  return {
    labels,
    intercept: Float64Array.from(intercept),
    coef: decodeFloat32(coefB64, rows * columns, `head ${name}`),
    rows,
    columns,
  }
}

/** Parse and validate a decoded `weights.json` payload. */
export function parseWeights(payload: unknown, path: string): LoadedModel {
  const root = asRecord(payload, path)
  const numericNames = asStringArray(root.numericFeatures, `${path}: numericFeatures`)
  if (numericNames.join(' ') !== NUMERIC_FEATURE_NAMES.join(' ')) {
    throw new ModelError(
      `${path}: numericFeatures [${numericNames.join(', ')}] != features.ts ` +
        `[${NUMERIC_FEATURE_NAMES.join(', ')}] — re-run "npm run ml:export"`,
    )
  }
  const nBuckets = asNumber(root.nBuckets, `${path}: nBuckets`)
  if (!Number.isInteger(nBuckets) || nBuckets < 1) {
    throw new ModelError(`${path}: nBuckets must be a positive integer`)
  }
  const columns = nBuckets + N_NUMERIC

  const scaler = asRecord(root.scaler, `${path}: scaler`)
  const mean = asNumberArray(scaler.mean, `${path}: scaler.mean`)
  const scale = asNumberArray(scaler.scale, `${path}: scaler.scale`)
  if (mean.length !== N_NUMERIC || scale.length !== N_NUMERIC) {
    throw new ModelError(`${path}: scaler must hold ${N_NUMERIC} means and ${N_NUMERIC} scales`)
  }

  const rawHeads = asRecord(root.heads, `${path}: heads`)
  for (const name of HEAD_NAMES) {
    if (rawHeads[name] === undefined) throw new ModelError(`${path}: head '${name}' is missing`)
  }

  return {
    nBuckets,
    numericNames,
    mean: Float64Array.from(mean),
    scale: Float64Array.from(scale),
    heads: {
      category: decodeHead(rawHeads.category, 'category', columns),
      moment: decodeHead(rawHeads.moment, 'moment', columns),
    },
    trainedAt: root.trainedAt === undefined ? '' : asString(root.trainedAt, `${path}: trainedAt`),
    trainedRows:
      root.trainedRows === undefined ? 0 : asNumber(root.trainedRows, `${path}: trainedRows`),
    metrics: readMetrics(root.metrics, path),
    path,
  }
}

function readMetrics(raw: unknown, path: string): Record<string, number> {
  if (raw === undefined) return {}
  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(asRecord(raw, `${path}: metrics`))) {
    metrics[key] = asNumber(value, `${path}: metrics.${key}`)
  }
  return metrics
}

/**
 * The decoded model, read from disk on the first call and cached thereafter.
 *
 * Callers should treat the result as immutable; it is shared by every request.
 */
export function loadModel(): LoadedModel {
  if (cached !== null) return cached
  const path = resolveWeightsPath()
  let payload: unknown
  try {
    payload = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ModelError(`${path} could not be read as JSON: ${reason}`)
  }
  const model = parseWeights(payload, path)
  cached = model
  return model
}

/** Drop the cached weights so the next `loadModel()` reads from disk again. */
export function clearModelCache(): void {
  cached = null
}

/**
 * Round half-up to 6 decimals — the same three double operations Python's
 * `round6` performs.
 *
 * WHY not Python's built-in `round`: it is banker's rounding and would disagree
 * with JavaScript on exact ties, which is precisely the 1-ulp class of
 * difference the parity test exists to catch. Both sides compute
 * `floor(v * 1e6 + 0.5) / 1e6`, so both get the same answer.
 */
export function round6(value: number): number {
  return Math.floor(value * 1_000_000 + 0.5) / 1_000_000
}

/**
 * `softmax(W . x + b)` for one head, with the text half kept sparse — `x` is
 * 99.9% zeros by construction, so a dense product would be 65543 multiplies per
 * row to add nothing.
 *
 * The max subtraction before `exp` is not cosmetic: a confident head produces
 * large logits, and `exp(800)` is `Infinity`, which turns the whole distribution
 * into `NaN`.
 */
export function scoreHead(
  head: Head,
  buckets: ReadonlyMap<number, number>,
  scaled: Float64Array,
  nBuckets: number,
): number[] {
  const logits = new Float64Array(head.rows)
  for (let row = 0; row < head.rows; row += 1) {
    const base = row * head.columns
    let total = head.intercept[row]
    for (const [bucket, value] of buckets) {
      total += head.coef[base + bucket] * value
    }
    const numericBase = base + nBuckets
    for (let index = 0; index < scaled.length; index += 1) {
      total += head.coef[numericBase + index] * scaled[index]
    }
    logits[row] = total
  }

  let largest = -Infinity
  for (const logit of logits) {
    if (logit > largest) largest = logit
  }
  const exponentials = new Float64Array(head.rows)
  let sum = 0
  for (let row = 0; row < head.rows; row += 1) {
    const value = Math.exp(logits[row] - largest)
    exponentials[row] = value
    sum += value
  }
  const probabilities: number[] = []
  for (let row = 0; row < head.rows; row += 1) {
    probabilities.push(exponentials[row] / sum)
  }
  return probabilities
}

/**
 * The `limit` most probable labels, descending.
 *
 * Ties break on the label ascending so the ordering is stable across runs and
 * across languages — without it, two labels that land on the same probability
 * could come back in either order and the parity fixture would be flaky. Sorting
 * happens on the **unrounded** probabilities, exactly as `ml/predict.py` does,
 * so rounding can never reorder the list.
 */
export function topScored(
  labels: readonly string[],
  probabilities: readonly number[],
  limit = 3,
): Scored[] {
  const order = labels.map((_, index) => index)
  order.sort((left, right) => {
    if (probabilities[left] !== probabilities[right]) {
      return probabilities[left] > probabilities[right] ? -1 : 1
    }
    if (labels[left] === labels[right]) return 0
    return labels[left] < labels[right] ? -1 : 1
  })
  return order
    .slice(0, Math.min(limit, labels.length))
    .map(index => ({ label: labels[index], p: round6(probabilities[index]) }))
}

/**
 * Score one transaction against the cached weights (CONTRACTS §2.5).
 *
 * The dense block is standardised with the scaler fitted during training; the
 * sparse block is already L2-normalised by `hashedNgramIds`.
 */
export function classifyLocal(
  merchantRaw: string,
  amount: number,
  whenISO: string,
): ClassifyResult {
  const model = loadModel()
  const buckets = textFeatures(merchantRaw, model.nBuckets)
  const raw = numericFeatures(amount, whenISO)
  const scaled = new Float64Array(N_NUMERIC)
  for (let index = 0; index < N_NUMERIC; index += 1) {
    scaled[index] = (raw[index] - model.mean[index]) / model.scale[index]
  }

  const categoryTop = topScored(
    model.heads.category.labels,
    scoreHead(model.heads.category, buckets, scaled, model.nBuckets),
  )
  const momentTop = topScored(
    model.heads.moment.labels,
    scoreHead(model.heads.moment, buckets, scaled, model.nBuckets),
  )

  return {
    category: categoryTop[0].label,
    categoryConfidence: categoryTop[0].p,
    categoryTop3: categoryTop,
    moment: momentTop[0].label,
    momentConfidence: momentTop[0].p,
    momentTop3: momentTop,
    engine: 'local',
  }
}
