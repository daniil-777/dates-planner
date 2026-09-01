/**
 * SAP Document AI (Document Information Extraction) client — CONTRACTS.md §6.
 *
 * One interface, two implementations: a live BTP client and a mock that replays
 * bundled fixtures. The mock is what makes the whole scan flow developable and
 * testable without a BTP account, so it is a first-class citizen here, not an
 * afterthought.
 *
 * Nothing in this file may log credentials, tokens, request bodies or image
 * bytes. Job ids and job status are enough to debug a misbehaving scan.
 */
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { pickFixture } from './fixtures'
import { createLlmClient, llmExtractionConfigured } from './llm-extractor'
import type { DocAiClient, DocAiJobResult, DocAiSubmitOptions } from './types'

export type { DocAiClient } from './types'

const JOBS_PATH = '/document-information-extraction/v1/document/jobs'
const DEFAULT_DOCUMENT_TYPE = 'invoice'
const DEFAULT_HEADER_FIELDS = [
  'documentDate',
  'grossAmount',
  'currencyCode',
  'senderName',
  'senderAddress',
  'netAmount',
]
const DEFAULT_LINE_ITEM_FIELDS = ['description', 'quantity', 'netAmount']
/** The Document AI tenant a job is filed under — unrelated to the OAuth client id. */
const DOX_TENANT = 'default'

/** Artificial extraction delay of the mock, so the busy indicators get exercised. */
export const MOCK_DELAY_MS = 800
const DEFAULT_POLL_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 1_500
const REQUEST_TIMEOUT_MS = 30_000
/** Renew a token a minute early rather than let a job fail on an expiring one. */
const TOKEN_SAFETY_WINDOW_MS = 60_000
const MOCK_JOB_RETENTION_MS = 15 * 60_000
/** Everything below U+0020, plus DEL, is stripped before anything is logged. */
const FIRST_PRINTABLE = 0x20
const DELETE_CHAR = 0x7f

export class DocAiError extends Error {
  readonly status: number | undefined
  readonly jobId: string | undefined

  constructor(message: string, details: { status?: number; jobId?: string } = {}) {
    super(message)
    this.name = 'DocAiError'
    this.status = details.status
    this.jobId = details.jobId
  }
}

interface LiveConfig {
  url: string
  uaaUrl: string
  clientId: string
  clientSecret: string
  schemaName: string | null
  documentType: string
}

interface CachedToken {
  value: string
  expiresAt: number
}

interface MockJob {
  fixture: DocAiJobResult
  readyAt: number
}

const ENV_KEYS = [
  'MOCK_DOCAI',
  'DOCAI_URL',
  'DOCAI_UAA_URL',
  'DOCAI_CLIENT_ID',
  'DOCAI_CLIENT_SECRET',
  'DOCAI_SCHEMA_NAME',
  'DOCAI_DOCUMENT_TYPE',
  // Not a Document AI variable, but it decides whether the fallback reads the picture or
  // replays a fixture — so it has to invalidate the cached client the same way.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_EXTRACT_EFFORT',
]

function env(name: string): string | null {
  const raw = process.env[name]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Job ids and status only — see the file header. */
function log(message: string): void {
  console.log(`[documentai] ${message}`)
}

/**
 * File names and service error messages end up in the log, and both come from
 * outside: flatten control characters so neither can forge a second log line.
 */
function safeLabel(value: string, max = 80): string {
  let cleaned = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    cleaned += code < FIRST_PRINTABLE || code === DELETE_CHAR ? ' ' : char
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function readStatus(job: unknown): string | null {
  if (!isRecord(job) || typeof job.status !== 'string') return null
  return job.status.trim().toUpperCase()
}

/** Document AI reports failures in a few different envelopes; try all of them. */
function readFailureReason(job: unknown): string {
  if (!isRecord(job)) return 'no details'
  if (typeof job.errorMessage === 'string' && job.errorMessage !== '') return job.errorMessage
  if (isRecord(job.error) && typeof job.error.message === 'string') return job.error.message
  if (typeof job.message === 'string' && job.message !== '') return job.message
  return 'no details'
}

/* ---------------------------------------------------------------- config */

function mockRequested(): boolean {
  const flag = env('MOCK_DOCAI')
  return flag !== null && ['1', 'true', 'yes', 'on'].includes(flag.toLowerCase())
}

function readLiveConfig(): LiveConfig | null {
  const url = env('DOCAI_URL')
  const uaaUrl = env('DOCAI_UAA_URL')
  const clientId = env('DOCAI_CLIENT_ID')
  const clientSecret = env('DOCAI_CLIENT_SECRET')
  if (url === null || uaaUrl === null || clientId === null || clientSecret === null) return null
  return {
    url: url.replace(/\/+$/, ''),
    uaaUrl: uaaUrl.replace(/\/+$/, ''),
    clientId,
    clientSecret,
    schemaName: env('DOCAI_SCHEMA_NAME'),
    documentType: env('DOCAI_DOCUMENT_TYPE') ?? DEFAULT_DOCUMENT_TYPE,
  }
}

/**
 * The submit options double as the schema switch: the standard invoice fields by
 * default, a custom Document AI schema once DOCAI_SCHEMA_NAME points at one.
 */
function buildSubmitOptions(config: LiveConfig): DocAiSubmitOptions {
  const options: DocAiSubmitOptions = {
    extraction: {
      headerFields: [...DEFAULT_HEADER_FIELDS],
      lineItemFields: [...DEFAULT_LINE_ITEM_FIELDS],
    },
    clientId: DOX_TENANT,
    documentType: config.documentType,
  }
  if (config.schemaName !== null) options.schemaName = config.schemaName
  return options
}

/* ------------------------------------------------------------------ live */

async function describeFailure(response: Response, what: string): Promise<DocAiError> {
  let detail = ''
  try {
    detail = safeLabel(await response.text(), 300)
  } catch {
    detail = ''
  }
  const suffix = detail === '' ? '' : `: ${detail}`
  return new DocAiError(
    `Document AI ${what} failed with HTTP ${response.status} ${response.statusText}${suffix}`,
    { status: response.status },
  )
}

function createLiveClient(config: LiveConfig): DocAiClient {
  let cachedToken: CachedToken | null = null

  /** Client-credentials token, cached until a minute before it expires. */
  const accessToken = async (): Promise<string> => {
    if (cachedToken !== null && cachedToken.expiresAt > Date.now()) return cachedToken.value

    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
    const response = await fetch(`${config.uaaUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    // Deliberately no response body in this message: the token endpoint is the
    // one place where a reply could quote back what we sent.
    if (!response.ok) {
      throw new DocAiError(
        `Document AI token request failed with HTTP ${response.status} ${response.statusText}`,
        { status: response.status },
      )
    }
    const payload: unknown = await response.json()
    if (!isRecord(payload) || typeof payload.access_token !== 'string') {
      throw new DocAiError('Document AI token response did not contain an access_token')
    }
    const lifetimeSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 3600
    const lifetimeMs = Math.max(lifetimeSeconds * 1000 - TOKEN_SAFETY_WINDOW_MS, 0)
    cachedToken = { value: payload.access_token, expiresAt: Date.now() + lifetimeMs }
    return cachedToken.value
  }

  const submitJob = async (image: Buffer, mimeType: string, fileName: string): Promise<string> => {
    const token = await accessToken()
    const name = fileName.trim() === '' ? 'receipt' : fileName
    const form = new FormData()
    form.append('file', new Blob([image], { type: mimeType || 'application/octet-stream' }), name)
    // The options part must carry `Content-Type: application/json`; sent as a
    // plain string field the service answers `400 options is not a valid JSON`.
    form.append(
      'options',
      new Blob([JSON.stringify(buildSubmitOptions(config))], { type: 'application/json' }),
    )

    const response = await fetch(`${config.url}${JOBS_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw await describeFailure(response, 'job submission')

    const payload: unknown = await response.json()
    if (!isRecord(payload) || typeof payload.id !== 'string' || payload.id === '') {
      throw new DocAiError('Document AI job submission did not return a job id')
    }
    log(`submitted job ${payload.id} (${safeLabel(name)})`)
    return payload.id
  }

  const getJob = async (jobId: string): Promise<unknown> => {
    const token = await accessToken()
    const response = await fetch(`${config.url}${JOBS_PATH}/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw await describeFailure(response, `job ${jobId} lookup`)
    const payload: unknown = await response.json()
    return payload
  }

  /** Polls until a terminal state; a stuck job must not hang the scan request forever. */
  const pollJob = async (
    jobId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<unknown> => {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const deadline = Date.now() + timeoutMs
    let lastStatus = 'UNKNOWN'

    for (;;) {
      const job = await getJob(jobId)
      const status = readStatus(job)
      if (status !== null) lastStatus = status
      if (status === 'DONE') {
        log(`job ${jobId} status DONE`)
        return job
      }
      // DELETING is terminal too: polling a job that is on its way out would
      // otherwise burn the whole timeout before reporting anything useful.
      if (status === 'FAILED' || status === 'ERROR' || status === 'DELETING') {
        log(`job ${jobId} status ${status}`)
        throw new DocAiError(
          `Document AI job ${jobId} failed with status ${status}: ${safeLabel(
            readFailureReason(job),
            200,
          )}`,
          { jobId },
        )
      }
      if (Date.now() + intervalMs >= deadline) {
        throw new DocAiError(
          `Document AI job ${jobId} did not finish within ${timeoutMs} ms (last status ${lastStatus})`,
          { jobId },
        )
      }
      await sleep(intervalMs)
    }
  }

  return { submitJob, getJob, pollJob, mode: 'live' }
}

/* ------------------------------------------------------------------ mock */

function createMockClient(): DocAiClient {
  const jobs = new Map<string, MockJob>()

  /** Keeps a long-running dev server from accumulating mock jobs forever. */
  const prune = (): void => {
    const cutoff = Date.now() - MOCK_JOB_RETENTION_MS
    for (const [id, job] of jobs) {
      if (job.readyAt < cutoff) jobs.delete(id)
    }
  }

  const submitJob = async (
    _image: Buffer,
    _mimeType: string,
    fileName: string,
  ): Promise<string> => {
    prune()
    const jobId = `mock-${randomUUID()}`
    jobs.set(jobId, { fixture: pickFixture(fileName), readyAt: Date.now() + MOCK_DELAY_MS })
    log(`submitted mock job ${jobId} (${safeLabel(fileName)})`)
    return jobId
  }

  const requireJob = (jobId: string): MockJob => {
    const job = jobs.get(jobId)
    if (!job) throw new DocAiError(`Document AI mock does not know job ${jobId}`, { jobId })
    return job
  }

  /** Pending until the artificial delay has elapsed, so polling behaves like the real thing. */
  const getJob = async (jobId: string): Promise<unknown> => {
    const job = requireJob(jobId)
    if (Date.now() < job.readyAt) return { id: jobId, status: 'PENDING' }
    return { ...job.fixture, id: jobId }
  }

  /** Waits out the remaining delay in one go, so a mock scan costs exactly MOCK_DELAY_MS. */
  const pollJob = async (
    jobId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<unknown> => {
    const job = requireJob(jobId)
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const remaining = Math.max(job.readyAt - Date.now(), 0)
    if (remaining > timeoutMs) {
      throw new DocAiError(
        `Document AI job ${jobId} did not finish within ${timeoutMs} ms (last status PENDING)`,
        { jobId },
      )
    }
    await sleep(remaining)
    log(`mock job ${jobId} status DONE`)
    return { ...job.fixture, id: jobId }
  }

  return { submitJob, getJob, pollJob, mode: 'mock' }
}

/* --------------------------------------------------------------- factory */

let cached: { signature: string; client: DocAiClient } | null = null

/**
 * Hashed rather than concatenated so the cache key never holds a second copy of
 * the client secret in memory.
 */
function envSignature(): string {
  const digest = createHash('sha256')
  for (const key of ENV_KEYS) digest.update(`${key}=${process.env[key] ?? ''} `)
  return digest.digest('hex')
}

/**
 * Returns the shared client, rebuilding it only when the Document AI environment
 * changed — which keeps the OAuth token cached across scans while still letting
 * tests flip between mock and live.
 */
export function getDocAiClient(): DocAiClient {
  const signature = envSignature()
  if (cached !== null && cached.signature === signature) return cached.client

  // Order of preference, and the reasoning for it: SAP Document AI is what this app is
  // built around and is the only engine trained on the document types it names, so it wins
  // whenever it is configured. Claude reading the image is the fallback that still actually
  // reads the image. Fixtures are last, because they do not.
  //
  // MOCK_DOCAI forces fixtures past both, which is what makes a deploy testable without
  // spending BTP quota or Anthropic tokens.
  const config = mockRequested() ? null : readLiveConfig()
  let client: DocAiClient
  if (config !== null) client = createLiveClient(config)
  else if (!mockRequested() && llmExtractionConfigured()) client = createLlmClient()
  else client = createMockClient()

  if (client.mode === 'live') {
    log('live mode')
  } else if (client.mode === 'llm') {
    log('llm mode (no Document AI credentials; reading receipts with ANTHROPIC_API_KEY)')
  } else {
    log(mockRequested() ? 'mock mode (MOCK_DOCAI)' : 'mock mode (no credentials of any kind)')
  }
  cached = { signature, client }
  return client
}
