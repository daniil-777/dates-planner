/**
 * The chat half of the API, kept beside the page that uses it.
 *
 * Separate from `src/api/client.ts` for one reason: the live stream is not a request. It is
 * an `EventSource` with its own lifecycle, reconnection and teardown, and folding that into
 * a module of `fetch` wrappers would make both harder to read.
 */

const LEDGER = '/api/ledger'

export interface ChatMessage {
  ID: string
  at: string
  kind: 'text' | 'audio' | 'image'
  body: string | null
  mediaType: string | null
  durationMs: number | null
  /** Amplitudes 0..1, as the sender captured them. Null when the shape was unusable. */
  peaks: number[] | null
  authorId: string | null
  authorName: string
  authorColour: string
  mine: boolean
}

export interface Conversation {
  ID: string
  title: string
}

export class ChatError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ChatError'
    this.status = status
  }
}

async function read(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** CAP wraps an error as `{ error: { message } }`; that message is written for a person. */
function fail(status: number, body: unknown, fallback: string): ChatError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  const message = typeof error?.message === 'string' ? error.message : fallback
  return new ChatError(status, message)
}

async function get(path: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${LEDGER}${path}`, { credentials: 'include' })
  } catch {
    throw new ChatError(0, 'Could not reach the server.')
  }
  const body = await read(response)
  if (!response.ok) throw fail(response.status, body, 'That did not work.')
  return body
}

/** The household's thread, created on first ask if it does not exist yet. */
export async function conversation(): Promise<Conversation> {
  const body = await get('/conversation()')
  const row = isRecord(body) ? body : {}
  return { ID: String(row.ID ?? ''), title: String(row.title ?? 'Us') }
}

/**
 * The thread, oldest first.
 *
 * `since` is what the client already has: the stream says "something changed" and this
 * fetches only what is new, which is why the stream itself never carries message text.
 */
export async function messages(conversationId: string, since?: string): Promise<ChatMessage[]> {
  const args = `conversationId=${conversationId},since='${(since ?? '').replace(/'/g, "''")}'`
  const body = await get(`/messages(${args})`)
  const rows = isRecord(body) && Array.isArray(body.value) ? body.value : []
  return rows.filter(isRecord).map(toMessage)
}

function toMessage(row: Record<string, unknown>): ChatMessage {
  const kind = row.kind === 'audio' || row.kind === 'image' ? row.kind : 'text'
  return {
    ID: String(row.ID ?? ''),
    at: String(row.at ?? ''),
    kind,
    body: typeof row.body === 'string' ? row.body : null,
    mediaType: typeof row.mediaType === 'string' ? row.mediaType : null,
    durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
    peaks: parsePeaks(row.peaks),
    authorId: typeof row.authorId === 'string' ? row.authorId : null,
    authorName: String(row.authorName ?? 'Somebody'),
    authorColour: String(row.authorColour ?? '#5B738B'),
    mine: row.mine === true,
  }
}

/** Null rather than an exception: a bubble with no waveform is fine, a crash is not. */
function parsePeaks(value: unknown): number[] | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    const numbers = parsed.filter((entry): entry is number => typeof entry === 'number')
    return numbers.length > 0 ? numbers : null
  } catch {
    return null
  }
}

async function send(payload: Record<string, unknown>): Promise<ChatMessage> {
  let response: Response
  try {
    response = await fetch(`${LEDGER}/sendMessage`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new ChatError(0, 'Could not reach the server.')
  }
  const body = await read(response)
  if (!response.ok) throw fail(response.status, body, 'That message did not send.')
  return toMessage(isRecord(body) ? body : {})
}

export async function sendText(conversationId: string, body: string): Promise<ChatMessage> {
  return send({ conversationId, kind: 'text', body })
}

/**
 * Send a voice note.
 *
 * The blob is base64'd into the action body, the same way `scanReceipt` sends a receipt —
 * one code path for binary, and one place where its size limit is enforced.
 */
export async function sendVoice(
  conversationId: string,
  recording: { blob: Blob; mediaType: string; durationMs: number; peaks: number[] },
): Promise<ChatMessage> {
  return send({
    conversationId,
    kind: 'audio',
    media: await toBase64(recording.blob),
    mediaType: recording.mediaType,
    durationMs: Math.round(recording.durationMs),
    peaks: JSON.stringify(recording.peaks.map(peak => Number(peak.toFixed(3)))),
  })
}

/** Chunked so a two-minute note does not blow the argument limit of `String.fromCharCode`. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

/** Where a voice note's audio lives. Cookie-authenticated and group-scoped, never public. */
export function mediaUrl(messageId: string): string {
  return `${LEDGER}/Messages(${messageId})/media`
}

/**
 * Listen for messages.
 *
 * `EventSource` reconnects by itself and resends `Last-Event-ID`, so this deliberately adds
 * no retry logic of its own — the browser's is better tested than anything written here.
 * The `onChange` callback receives no payload because the events carry none: they say that
 * something arrived, and the caller refetches what it has not seen.
 */
export function listen(onChange: () => void, onState?: (live: boolean) => void): () => void {
  if (typeof EventSource === 'undefined') {
    onState?.(false)
    return () => {}
  }

  const source = new EventSource('/api/chat/stream', { withCredentials: true })
  source.addEventListener('message', () => onChange())
  source.addEventListener('open', () => onState?.(true))
  source.addEventListener('error', () => {
    // `EventSource` reports a dropped connection and a failed reconnect the same way; it
    // will keep trying either way, so this only updates the indicator.
    onState?.(source.readyState === EventSource.OPEN)
  })
  return () => source.close()
}
