/**
 * The session client — the only part of the frontend that talks to `/api/auth/*`.
 *
 * It is deliberately self-contained: no import from `api/client.ts`, no TanStack Query, no
 * shared `ApiError`. Sign-in runs *before* the app exists, so it must not depend on
 * anything the app sets up, and a broken ledger client must never be able to lock somebody
 * out of the login screen.
 *
 * Three rules the rest of the file follows:
 *
 *   1. **The cookie is the session.** Every call sends `credentials: 'include'` and nothing
 *      else; no token is read, stored or logged, and the browser owns the 7-day lifetime.
 *   2. **Errors carry a status and a sentence a person can read.** The sentence is derived
 *      from the status alone — never from the response body, and never from the request —
 *      so a password cannot travel inside an error message, a log line, or a stack trace.
 *   3. **`me()` answers a question, it does not fail.** "Not signed in" is a normal answer
 *      (`null`), not an exception; only a server or network fault throws.
 */

/** The signed-in identity, as much of it as the UI needs. */
export interface AuthUser {
  /** The login name the session belongs to. */
  username: string
  /** A prettier name when the server has one, otherwise `null`. */
  displayName: string | null
}

/**
 * A failed call to `/api/auth/*`.
 *
 * `status` is the HTTP status, or `0` when the request never reached a server. `message` is
 * always a finished sentence, safe to render in the card as-is.
 */
export class AuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

const AUTH_BASE = '/api/auth'

/** Sent on every call: the cookie, and JSON both ways. */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
}

/**
 * The human sentence for a status.
 *
 * Wrong credentials and a missing account read identically on purpose — telling the two
 * apart would turn the form into a list of valid usernames.
 */
function messageFor(status: number, action: 'sign in' | 'sign out'): string {
  if (status === 0) return 'Could not reach the server. Check your connection and try again.'
  if (status === 401 || status === 403) {
    return action === 'sign in'
      ? 'That username and password did not match'
      : 'Your session has already ended.'
  }
  if (status === 429) return 'Too many attempts. Wait a minute, then try again.'
  if (status >= 500) return `The server could not ${action} right now. Try again in a moment.`
  return `Could not ${action}. Try again.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** First non-empty string among `keys`, trimmed. */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * Reads a user out of whatever `/api/auth/*` answered with.
 *
 * Both `{ user: { username } }` and a bare `{ username }` are accepted, as is a plain
 * `{ user: 'ada' }`, because this client is written against a session endpoint that the
 * server side may still be shaping. An explicit `authenticated: false` means "nobody",
 * and so does a payload with no name in it.
 */
export function parseUser(payload: unknown): AuthUser | null {
  if (!isRecord(payload)) return null
  if (payload.authenticated === false) return null

  const holder = isRecord(payload.user) ? payload.user : payload
  if (holder.authenticated === false) return null

  const username = readString(holder, ['username', 'user', 'name', 'id'])
  if (username === null) return null

  return { username, displayName: readString(holder, ['displayName', 'name']) }
}

/** Parses a JSON body, tolerating an empty one (a 204 logout has no body). */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (text.trim().length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * One fetch, with the cookie attached and a transport failure turned into `AuthError(0)`.
 *
 * The `body` is passed straight through and never referenced again — in particular it is
 * never attached to an error, which is what keeps the password out of the failure path.
 */
async function call(
  path: string,
  init: RequestInit,
  action: 'sign in' | 'sign out',
): Promise<Response> {
  try {
    return await fetch(`${AUTH_BASE}${path}`, {
      credentials: 'include',
      headers: JSON_HEADERS,
      ...init,
    })
  } catch {
    throw new AuthError(0, messageFor(0, action))
  }
}

/**
 * Exchanges a username and password for a session cookie.
 *
 * Resolves with the signed-in user; throws `AuthError` on anything else. The password lives
 * only in the request body and in the caller's state — it is never put into an error, and
 * this module never logs.
 */
export async function login(username: string, password: string): Promise<AuthUser> {
  const response = await call(
    '/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    'sign in',
  )

  if (!response.ok) throw new AuthError(response.status, messageFor(response.status, 'sign in'))

  const user = parseUser(await readJson(response))
  // A 200 with nothing recognisable in it still means the cookie was set; trust the status
  // and fall back to the name that was typed rather than bouncing the person back to the form.
  return user ?? { username: username.trim(), displayName: null }
}

/**
 * Ends the session.
 *
 * A 401 is success by another name — the session was already gone — so it resolves rather
 * than throwing, and the caller gets to show the login screen either way.
 */
export async function logout(): Promise<void> {
  const response = await call('/logout', { method: 'POST' }, 'sign out')
  if (response.ok || response.status === 401 || response.status === 403) return
  throw new AuthError(response.status, messageFor(response.status, 'sign out'))
}

/**
 * Who the cookie belongs to, or `null` when nobody is signed in.
 *
 * 401 and 403 are answers, not faults. Everything else throws, so that "the server is down"
 * and "you are signed out" are not silently the same thing to the gate above.
 */
export async function me(): Promise<AuthUser | null> {
  const response = await call('/me', { method: 'GET' }, 'sign in')

  if (response.status === 401 || response.status === 403) return null
  if (!response.ok) throw new AuthError(response.status, messageFor(response.status, 'sign in'))

  return parseUser(await readJson(response))
}
