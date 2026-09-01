/// <reference types="@cap-js/cds-types" />
/**
 * The sign-in flow, end to end over a real socket.
 *
 * What is being asserted is not "the login endpoint returns 200". It is the handful of
 * properties that decide whether a week-long session on a shared household ledger is safe:
 *
 * 1. The token arrives in an `httpOnly` cookie, never in a body the SPA could stash in
 *    `localStorage`, where one XSS would read it.
 * 2. A wrong password sets no cookie at all — not a short one, not an anonymous one.
 * 3. A token whose payload has been edited is refused, so `{"u":"partner-a"}` cannot be
 *    rewritten to somebody else and replayed.
 * 4. An expired token is refused, so a week actually means a week.
 * 5. `/api/auth/me` answers without credentials, because the SPA calls it before it has
 *    any and routes on the answer.
 * 6. Signing out clears the cookie with every attribute that set it, which is what a
 *    browser requires to drop it rather than keep both.
 *
 * And, underneath all of it, that HTTP basic auth still works: it is what `docs/API.md`
 * documents, what curl and the monitoring probe use, and what every deployment made before
 * this change is configured with.
 *
 * The app under test is `configureApp` on a bare express app, the way `test/security.test.ts`
 * assembles it — no CAP boot, so these assertions keep failing for the right reason on a day
 * when a service handler elsewhere does not compile. `srv/server.ts` is imported *after* the
 * credentials are in the environment, because it reads them once at module evaluation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import express from 'express'
import { createServer, type Server } from 'node:http'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSessionToken,
  parseCookies,
  verifySessionToken,
} from '../srv/lib/auth'

const USER_A = 'partner-a@example.com'
const USER_B = 'partner-b@example.com'
const PASSWORD = 'the passphrase on the fridge'
const PASSWORD_B = `${PASSWORD} B`

/**
 * A signing key for this file only, and a bcrypt cost of 4 rather than the CLI's 12.
 *
 * The cost factor is not what is under test here — `test/security.test.ts` covers the
 * hashing CLI — and twelve rounds per login attempt would add seconds to this suite for
 * nothing. The decoy hash the server builds follows whatever cost it is given, so the
 * "unknown user costs the same as a wrong password" property survives the reduction.
 */
const FIXTURE_SECRET = 'a signing key that exists only inside this test file'

const ENV: Readonly<Record<string, string>> = {
  AUTH_USER_A: USER_A,
  AUTH_HASH_A: bcrypt.hashSync(PASSWORD, 4),
  AUTH_USER_B: USER_B,
  AUTH_HASH_B: bcrypt.hashSync(PASSWORD_B, 4),
  SESSION_SECRET: FIXTURE_SECRET,
}

let server: Server
let origin: string
const savedEnv = new Map<string, string | undefined>()

beforeAll(async () => {
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv.set(name, process.env[name])
    process.env[name] = value
  }

  // Dynamic, and after the environment is set: `srv/server.ts` decides at module
  // evaluation whether a guard is mounted at all.
  const { configureApp } = await import('../srv/server.js')

  const app = express()
  configureApp(app)
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
})

/* ------------------------------------------------------------------ *
 *  1. Signing in
 * ------------------------------------------------------------------ */

describe('POST /api/auth/login', () => {
  it('sets an httpOnly session cookie that authenticates the next request', async () => {
    const response = await login(USER_A, PASSWORD)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ name: expect.any(String) })

    const setCookie = response.headers.getSetCookie()
    expect(setCookie).toHaveLength(1)
    const cookie = setCookie[0]

    // The flag this whole change exists for: a token in localStorage is readable by any
    // script that manages to run on the page.
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`)
    // No `Secure` outside production, or the browser would drop it on http://localhost and
    // the flow would be untestable on a laptop.
    expect(cookie).not.toContain('Secure')

    // The cookie carries a signed token, not the credential.
    const token = parseCookies(cookie)[SESSION_COOKIE]
    expect(token).toBeTypeOf('string')
    expect(cookie).not.toContain(PASSWORD)
    expect(verifySessionToken(token)).toMatchObject({ username: USER_A })

    // And it is accepted where a credential is required.
    const guarded = await fetch(`${origin}/health`, { headers: { cookie: jar(cookie) } })
    expect(guarded.status).toBe(200)
  })

  it('refuses a wrong password with a 401 and no cookie whatsoever', async () => {
    const response = await login(USER_A, 'not the passphrase')

    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie()).toEqual([])

    const body = await response.text()
    expect(body).toContain('invalid_credentials')
    expect(body).not.toContain('not the passphrase')
  })

  it('answers an unknown login exactly as it answers a wrong password', async () => {
    // Anything that distinguishes the two is a free list of who has an account here.
    const unknown = await login('someone-else@example.com', PASSWORD)
    const wrong = await login(USER_B, PASSWORD)

    expect(unknown.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await unknown.text()).toBe(await wrong.text())
    expect(unknown.headers.getSetCookie()).toEqual([])
  })

  it('takes every configured login, not only the first', async () => {
    const response = await login(USER_B, PASSWORD_B)

    expect(response.status).toBe(200)
    const token = parseCookies(response.headers.getSetCookie()[0])[SESSION_COOKIE]
    expect(verifySessionToken(token)).toMatchObject({ username: USER_B })
  })
})

/* ------------------------------------------------------------------ *
 *  2. What the guard does with a cookie
 * ------------------------------------------------------------------ */

describe('the session cookie as a credential', () => {
  it('rejects a token whose payload has been rewritten', async () => {
    const signature = issueSessionToken(USER_A).split('.')[1]
    // The forgery that matters: a valid, unexpired payload naming somebody else, carrying
    // a signature that was genuinely issued — just not for this payload.
    const forgedPayload = Buffer.from(
      JSON.stringify({ u: USER_B, exp: Date.now() + SESSION_TTL_MS }),
      'utf8',
    ).toString('base64url')

    expect(verifySessionToken(`${forgedPayload}.${signature}`)).toBeNull()
    expect(await statusWithCookie(`${forgedPayload}.${signature}`)).toBe(401)

    // …and the mirror image: the right payload with a doctored signature.
    const genuine = issueSessionToken(USER_A)
    const flipped = `${genuine.slice(0, -1)}${genuine.endsWith('A') ? 'B' : 'A'}`
    expect(await statusWithCookie(flipped)).toBe(401)

    // Nonsense in the cookie is a 401, not a 500.
    expect(await statusWithCookie('not-a-token')).toBe(401)
  })

  it('rejects a token that has expired', async () => {
    // Issued eight days ago, so its own expiry is a day in the past. The signature is
    // perfectly valid — expiry has to be checked separately or a session is forever.
    const expired = issueSessionToken(USER_A, Date.now() - SESSION_TTL_MS - 24 * 60 * 60 * 1000)

    expect(verifySessionToken(expired)).toBeNull()
    expect(await statusWithCookie(expired)).toBe(401)

    const me = await fetch(`${origin}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${expired}` },
    })
    expect(await me.json()).toMatchObject({ authenticated: false })
  })

  it('rejects a validly signed token for a login nobody configured', async () => {
    // Removing AUTH_USER_C from the environment has to end that person's sessions, not
    // merely stop them signing in again.
    const token = issueSessionToken('retired@example.com')

    expect(verifySessionToken(token)).toMatchObject({ username: 'retired@example.com' })
    expect(await statusWithCookie(token)).toBe(401)
  })

  it('still accepts HTTP basic auth, which is what every existing deployment uses', async () => {
    const response = await fetch(`${origin}/health`, { headers: basic(USER_A, PASSWORD) })
    expect(response.status).toBe(200)

    const wrong = await fetch(`${origin}/health`, { headers: basic(USER_A, 'nope') })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toMatch(/^Basic realm=/)
  })

  it('serves the SPA shell to a signed-out browser instead of a credential popup', async () => {
    // A 401 on a top-level navigation is what makes the browser draw its own login dialog.
    // The shell carries no ledger data; it boots, calls /api/auth/me and renders a form.
    const response = await fetch(`${origin}/`)

    expect(response.status).not.toBe(401)
    expect(response.headers.get('www-authenticate')).toBeNull()

    // The data behind it is emphatically not public.
    expect((await fetch(`${origin}/api/ledger/Expenses`)).status).toBe(401)
  })
})

/* ------------------------------------------------------------------ *
 *  3. /api/auth/me
 * ------------------------------------------------------------------ */

describe('GET /api/auth/me', () => {
  it('answers 200 with no credentials at all, because the SPA routes on it', async () => {
    const response = await fetch(`${origin}/api/auth/me`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')

    const payload: unknown = await response.json()
    expect(payload).toMatchObject({ authenticated: false, username: null })
    // The person fields are always present, so the SPA never has to feature-detect them.
    // They are null here only because this bare app has no database behind it.
    expect(payload).toHaveProperty('personId')
    expect(payload).toHaveProperty('personName')
  })

  it('names the signed-in login once a session cookie is presented', async () => {
    const cookie = jar((await login(USER_A, PASSWORD)).headers.getSetCookie()[0])

    const response = await fetch(`${origin}/api/auth/me`, { headers: { cookie } })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authenticated: true, username: USER_A })
  })

  it('recognises basic auth too', async () => {
    const response = await fetch(`${origin}/api/auth/me`, { headers: basic(USER_B, PASSWORD_B) })

    expect(await response.json()).toMatchObject({ authenticated: true, username: USER_B })
  })
})

/* ------------------------------------------------------------------ *
 *  4. Signing out
 * ------------------------------------------------------------------ */

describe('POST /api/auth/logout', () => {
  it('clears the cookie with the attributes that set it', async () => {
    const response = await fetch(`${origin}/api/auth/logout`, { method: 'POST' })

    expect(response.status).toBe(204)

    const cookie = response.headers.getSetCookie()[0]
    expect(cookie).toContain(`${SESSION_COOKIE}=;`)
    expect(cookie).toContain('Max-Age=0')
    // A browser matches on name, path and flags; miss one and it keeps both cookies and
    // sends the old one.
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('succeeds for a request that was never signed in', async () => {
    // Signing out when you are not sure whether you were signed in is the normal case.
    const response = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=garbage` },
    })

    expect(response.status).toBe(204)
  })
})

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function login(username: string, password: string): Promise<Response> {
  return fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

/** The status `/health` — which is behind the guard — gives to this session token. */
async function statusWithCookie(token: string): Promise<number> {
  const response = await fetch(`${origin}/health`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })
  return response.status
}

/** A `Set-Cookie` value reduced to what a browser would send back. */
function jar(setCookie: string): string {
  return setCookie.split(';')[0]
}

function basic(username: string, password: string): Record<string, string> {
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return { authorization: `Basic ${encoded}` }
}
