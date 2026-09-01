/**
 * Public surface of the classifier (CONTRACTS §5).
 *
 * Consumers import `classify` from here and never touch `model.ts` or
 * `features.ts` directly, which is what lets the local/remote split stay an
 * implementation detail: the same call either scores in-process from
 * `ml/model/weights.json` or POSTs to a Python sidecar / SAP AI Core deployment,
 * decided entirely by whether `CLASSIFIER_URL` is set.
 *
 * The remote path is an *escape hatch*, not a dependency. Every failure mode —
 * unset token, expired token, deployment scaled to zero, DNS hiccup, malformed
 * response — falls back to local inference and logs one line. The app keeps
 * working; all it loses is the `'remote'` label on the result.
 *
 * Nothing here logs the request or the response body. A classify payload is a
 * merchant name, an amount and a timestamp — i.e. where the people who live here were
 * and what they spent — and that has no business in a log aggregator.
 */

import { classifyLocal, clearModelCache } from './model'
import type { ClassifyResult, Scored } from './model'

export type { ClassifyResult, Scored }
export {
  ModelError,
  clearModelCache,
  classifyLocal,
  loadModel,
  round6,
  scoreHead,
  topScored,
} from './model'
export type { Head, LoadedModel } from './model'
export {
  N_GRAM_MAX,
  N_GRAM_MIN,
  NUMERIC_FEATURE_NAMES,
  N_NUMERIC,
  charWbNgrams,
  hashedNgramIds,
  normaliseMerchant,
  numericFeatures,
  textFeatures,
} from './features'
export { crc32, crc32Utf8 } from './crc32'

/**
 * How long a remote classify may take before the local path takes over.
 *
 * Short on purpose: this call sits in the request path of "scan a receipt", and
 * a cold AI Core deployment that will never answer must not hold the user's
 * upload open. Local inference costs about a millisecond, so waiting longer for
 * the remote is never worth it.
 */
export const REMOTE_TIMEOUT_MS = 8_000

/**
 * Classify one transaction into a category and a moment.
 *
 * Remote when `CLASSIFIER_URL` is set and answers, local otherwise. Probabilities
 * are rounded to 6 decimals by whichever engine produced them, so the two agree
 * with `ml/predict.py` to the digit.
 */
export async function classify(
  merchantRaw: string,
  amount: number,
  whenISO: string,
): Promise<ClassifyResult> {
  const url = env('CLASSIFIER_URL')
  if (url !== undefined) {
    const remote = await classifyRemote(url, merchantRaw, amount, whenISO)
    if (remote !== null) return remote
  }
  return classifyLocal(merchantRaw, amount, whenISO)
}

/** Drops the cached weights so the next `classify()` reloads from disk. */
export function reloadModel(): void {
  clearModelCache()
}

/**
 * POST the transaction to the configured endpoint, or return `null` so the
 * caller falls back.
 *
 * Returns `null` rather than throwing because "the remote is unavailable" is not
 * an error condition for this app — it is the normal state whenever the token
 * has aged out — and a rejected promise here would turn a working local
 * classifier into a failed receipt scan.
 */
async function classifyRemote(
  url: string,
  merchantRaw: string,
  amount: number,
  whenISO: string,
): Promise<ClassifyResult | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ merchantRaw, amount, whenISO }),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    })
    if (!response.ok) {
      // The status line is safe to log; the body may quote the merchant back.
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
    return readRemoteResult(await response.json())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[classifier] remote classify failed (${reason}), falling back to local`)
    return null
  }
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const token = env('CLASSIFIER_TOKEN')
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const resourceGroup = env('CLASSIFIER_RESOURCE_GROUP')
  // AI Core rejects inference calls without this header; a plain Python sidecar
  // ignores it. Sending it whenever it is configured suits both.
  if (resourceGroup !== undefined) headers['AI-Resource-Group'] = resourceGroup
  return headers
}

/**
 * Validate a remote response into a `ClassifyResult`.
 *
 * The endpoint is trusted to be ours but not to be *current* — a sidecar built
 * against an older contract, or an AI Core route pointing at someone else's
 * deployment, would otherwise inject `undefined` into an expense record. Anything
 * that is not the §5 shape throws, and the caller falls back to local.
 *
 * `engine` is forced to `'remote'` regardless of what the response claimed: the
 * field describes where this process got its answer, and `ml/serve.py` has no
 * way of knowing it was called remotely.
 */
function readRemoteResult(payload: unknown): ClassifyResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('response was not a JSON object')
  }
  const body = payload as Record<string, unknown>
  return {
    category: requireString(body.category, 'category'),
    categoryConfidence: requireProbability(body.categoryConfidence, 'categoryConfidence'),
    categoryTop3: requireScored(body.categoryTop3, 'categoryTop3'),
    moment: requireString(body.moment, 'moment'),
    momentConfidence: requireProbability(body.momentConfidence, 'momentConfidence'),
    momentTop3: requireScored(body.momentTop3, 'momentTop3'),
    engine: 'remote',
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`response field '${field}' was not a non-empty string`)
  }
  return value
}

function requireProbability(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`response field '${field}' was not a probability`)
  }
  return value
}

function requireScored(value: unknown, field: string): Scored[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`response field '${field}' was not a non-empty array`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`response field '${field}[${index}]' was not an object`)
    }
    const scored = entry as Record<string, unknown>
    return {
      label: requireString(scored.label, `${field}[${index}].label`),
      p: requireProbability(scored.p, `${field}[${index}].p`),
    }
  })
}

/** Treats blank env vars as unset, which is how a commented-out `.env` line behaves. */
function env(name: string): string | undefined {
  const value = process.env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
