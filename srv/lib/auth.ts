/**
 * Sessions: the credential check, the signed token, and the cookie that carries it.
 *
 * HTTP basic auth works, and `srv/server.ts` still accepts it — but it is a bad *browser*
 * experience: the credential lives in the browser's password manager, every request
 * re-sends it, there is no way to sign out, and an unauthenticated navigation opens the
 * chrome-drawn popup instead of a page this app designed. So the browser path is a cookie
 * session, and basic auth stays as the fallback for curl, monitoring and existing
 * deployments.
 *
 * Three properties are worth stating outright, because each one is a decision:
 *
 *  - **The cookie is `httpOnly`.** That is the whole point of putting the token in a cookie
 *    rather than in `localStorage`: a token in web storage is readable by any script that
 *    manages to run on the page, and a single XSS then exfiltrates a login that lasts a
 *    week. `httpOnly` puts it somewhere JavaScript cannot reach at all.
 *  - **The token is signed, not encrypted, and carries no secret.** It says who and until
 *    when; both are things the holder already knows. What the HMAC buys is that neither
 *    field can be edited.
 *  - **`Secure` is set only in production.** A `Secure` cookie is dropped by the browser on
 *    `http://localhost`, which would make the whole flow untestable on a laptop. Production
 *    is behind TLS and gets the flag.
 *
 * Nothing here is ever logged. The hashes, the token and the secret stay inside this file.
 */
import bcrypt from 'bcryptjs'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** The cookie name. One string, so the SPA, the server and the tests cannot drift. */
export const SESSION_COOKIE = 'twm_session'

/**
 * How long a session lasts.
 *
 * A week: long enough that the two people who use this never meet the login screen in
 * ordinary use, short enough that a stolen laptop is not a permanent grant. There is no
 * sliding renewal — a fixed expiry is one fewer moving part, and re-signing in once a week
 * is not a burden.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A configured login, with the hash deliberately left behind. */
export interface AuthAccount {
  /** The login as configured, matched against `People.email` for display purposes. */
  username: string
  /** The `A` of `AUTH_USER_A` — names a slot in the configuration, never a person. */
  slot: string
  /** The variable the login came from, for error messages that can be acted on. */
  variable: string
}

/** What a valid token turns back into. */
export interface Session {
  username: string
  /** Epoch milliseconds. Always in the future for a session that verified. */
  expiresAt: number
}

interface StoredAccount extends AuthAccount {
  /** A bcrypt hash. Never returned, never logged. */
  hash: string
}

/** `$2a$`, `$2b$` or `$2y$`, cost 04–99, 53 characters of salt-and-digest. */
const BCRYPT_HASH = /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/

/**
 * Open-door mode: any username, any non-empty password, no configuration needed.
 *
 * `AUTH_ALLOW_ANY=1` makes the sign-in form accept whatever is typed into it. It exists for
 * one purpose — handing somebody the link without first issuing them a credential — and it
 * is the only switch in this file that trades safety for reach.
 *
 * Be clear about what it costs: while it is on, everything the ledger holds is readable and
 * writable by anyone who knows the URL. There is no second gate behind it.
 *
 * What it does *not* do is remove the sign-in step. An anonymous request is still
 * challenged and still gets the login screen, so a session still has a name attached and
 * `People.email` still resolves for anyone whose typed name happens to match a row.
 * Unsetting the flag restores the configured logins with no other change.
 */
export function allowAnyCredentials(): boolean {
  const raw = (process.env.AUTH_ALLOW_ANY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/* ------------------------------------------------------------------ *
 *  Configured logins
 * ------------------------------------------------------------------ */

/**
 * Every complete `AUTH_USER_<slot>` / `AUTH_HASH_<slot>` pair in the environment.
 *
 * Discovered rather than hard-coded, because the ledger no longer holds exactly two people
 * (CONTRACTS.md §10): `AUTH_USER_A` and `AUTH_USER_B` are two ordinary slots and
 * `AUTH_USER_C` is a third login with no code change. Read on every call rather than
 * cached, so a test — or a restart-free redeploy — can change the environment and be
 * believed.
 *
 * Incomplete or malformed slots are skipped in silence here. They are not ignored by the
 * program: `srv/server.ts` refuses to start on them in production, which is where a
 * half-configured login is a deployment mistake rather than a laptop with a stray variable.
 */
export function configuredAccounts(): AuthAccount[] {
  return storedAccounts().map(({ username, slot, variable }) => ({ username, slot, variable }))
}

function storedAccounts(): StoredAccount[] {
  const slots = new Set<string>()
  for (const name of Object.keys(process.env)) {
    const match = /^AUTH_(?:USER|HASH)_([A-Za-z0-9_]+)$/.exec(name)
    if (match !== null) slots.add(match[1])
  }

  const accounts: StoredAccount[] = []
  for (const slot of [...slots].sort()) {
    const variable = `AUTH_USER_${slot}`
    const username = (process.env[variable] ?? '').trim()
    const hash = (process.env[`AUTH_HASH_${slot}`] ?? '').trim()
    if (username === '' || !BCRYPT_HASH.test(hash)) continue
    // Two slots sharing a login is a typo, and the later one would silently win.
    if (accounts.some(account => account.username === username)) continue
    accounts.push({ username, hash, slot, variable })
  }
  return accounts
}

/**
 * Check a username and password against the configured logins.
 *
 * Two timing properties, both deliberate:
 *
 *  - the username comparison is constant-time *and* runs against every account with no
 *    early exit, so the time taken says nothing about which login was tried;
 *  - exactly one bcrypt verification happens either way — an unknown username is checked
 *    against a decoy hash of the same cost, so "no such user" and "wrong password" take the
 *    same quarter of a second. Without that, an attacker enumerates the logins for free.
 *
 * `unknown` rather than `string` because the immediate caller is a JSON request body.
 * Returns the account on success and `null` on every failure, including "nothing is
 * configured" — a server with no logins has no login to grant.
 */
export async function verifyCredentials(
  username: unknown,
  password: unknown,
): Promise<AuthAccount | null> {
  if (typeof username !== 'string' || typeof password !== 'string') return null

  // Configured logins get first refusal, and keep the timing properties described above.
  // Only what they reject falls through to the open door below, so a real credential still
  // resolves to its own slot and its own Person instead of being flattened into `ANY`.
  // `srv/server.ts` resolves basic auth in the same order, and the two must not disagree.
  const accounts = storedAccounts()
  if (accounts.length > 0) {
    let matched: StoredAccount | null = null
    for (const account of accounts) {
      if (constantTimeEquals(account.username, username)) matched = account
    }

    const ok = await bcrypt.compare(password, matched?.hash ?? decoyHash(accounts[0].hash))
    if (ok && matched !== null) {
      return { username: matched.username, slot: matched.slot, variable: matched.variable }
    }
  }

  // Open door. A blank name or password is still refused: a session needs something to be
  // called by, and an empty form is a mistake rather than a login.
  if (allowAnyCredentials()) {
    const offered = username.trim()
    if (offered === '' || password === '') return null
    return { username: offered, slot: 'ANY', variable: 'AUTH_ALLOW_ANY' }
  }
  return null
}

/**
 * A hash of 32 bytes nobody knows, at the same cost factor as the real ones so that
 * verifying against it takes the same time. Computed once per cost factor, lazily, because
 * a bcrypt round is a quarter of a second that a server with no login attempts should not
 * spend at startup.
 */
let decoy: { rounds: number; hash: string } | null = null

function decoyHash(reference: string): string {
  const rounds = bcrypt.getRounds(reference)
  if (decoy === null || decoy.rounds !== rounds) {
    decoy = { rounds, hash: bcrypt.hashSync(randomBytes(32).toString('hex'), rounds) }
  }
  return decoy.hash
}

/**
 * Compare two strings without leaking their contents *or* their lengths through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, and catching that would itself be a length
 * oracle, so both sides are hashed to a fixed 32 bytes first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  )
}

/* ------------------------------------------------------------------ *
 *  The session token
 * ------------------------------------------------------------------ */

/**
 * The signing key: `SESSION_SECRET`, or 32 random bytes chosen once per boot.
 *
 * The fallback is what lets `npm run dev` work with no configuration at all — the whole
 * flow is exercisable on a laptop with an empty `.env`. It is safe rather than convenient:
 * a random key is a *stronger* key than a configured one, it simply does not survive a
 * restart, so every session ends when the process does. In production that means "everyone
 * signs in again after a deploy" and, across several instances, "the cookie only works on
 * the instance that issued it" — which is why `srv/server.ts` warns about it there. It is
 * never a weakening, only an inconvenience, so it is not worth refusing to boot over.
 *
 * The environment is read on every call so that a test can set the variable after this
 * module has loaded.
 */
let bootSecret: Buffer | null = null

function sessionSecret(): Buffer {
  const configured = (process.env.SESSION_SECRET ?? '').trim()
  // Hashed rather than used raw so that the key is 32 bytes whatever the passphrase is.
  if (configured !== '') return createHash('sha256').update(configured, 'utf8').digest()
  if (bootSecret === null) bootSecret = randomBytes(32)
  return bootSecret
}

/** Is the signing key configured, rather than the per-boot random one? */
export function sessionSecretConfigured(): boolean {
  return (process.env.SESSION_SECRET ?? '').trim() !== ''
}

/**
 * Mint a token for `username`, valid for {@link SESSION_TTL_MS} from `issuedAt`.
 *
 * `issuedAt` is a parameter rather than an implicit `Date.now()` so that a test can mint an
 * already-expired token without waiting a week or stubbing the clock.
 */
export function issueSessionToken(username: string, issuedAt: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: issuedAt + SESSION_TTL_MS }),
    'utf8',
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload, 'utf8').digest('base64url')
}

/**
 * Turn a token back into a session, or `null`.
 *
 * The signature is checked **before** the payload is parsed, so a forged token never
 * reaches `JSON.parse`, and the comparison is `timingSafeEqual` over two fixed-length
 * digests rather than `===` over two strings.
 */
export function verifySessionToken(
  token: string | undefined,
  now: number = Date.now(),
): Session | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const payload = token.slice(0, dot)
  const expected = Buffer.from(sign(payload), 'base64url')
  const offered = Buffer.from(token.slice(dot + 1), 'base64url')
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const { u, exp } = parsed as { u?: unknown; exp?: unknown }
  if (typeof u !== 'string' || u === '') return null
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return null
  return { username: u, expiresAt: exp }
}

/* ------------------------------------------------------------------ *
 *  The cookie
 * ------------------------------------------------------------------ */

/**
 * `Set-Cookie` for a fresh session.
 *
 * `SameSite=Lax` rather than `Strict`: `Strict` withholds the cookie on the first request
 * of a link followed in from anywhere, which would show the sign-in screen to somebody who
 * is signed in. `Lax` still withholds it from cross-site POSTs, which is the CSRF case that
 * matters, and `srv/server.ts` rejects foreign origins outright on top of that.
 */
export function sessionCookie(token: string): string {
  return serialiseCookie(token, Math.floor(SESSION_TTL_MS / 1000))
}

/**
 * `Set-Cookie` that ends the session.
 *
 * Every attribute has to match the one that set it or the browser keeps both, and the old
 * one is the one it sends.
 */
export function expiredSessionCookie(): string {
  return serialiseCookie('', 0)
}

function serialiseCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  // Only behind TLS: a Secure cookie is silently dropped on http://localhost, and dev is
  // http://localhost.
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

/**
 * Parse a `Cookie` header. `cookie-parser` is not a dependency and this is nine lines.
 *
 * The jar has a null prototype: assigning a key called `__proto__` to an object literal
 * rewrites its prototype rather than storing a value, and the key here comes off the wire.
 * First occurrence wins, which is what a browser means by a duplicate name.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const jar = Object.create(null) as Record<string, string>
  if (typeof header !== 'string') return jar

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name === '' || name in jar) continue
    let value = part.slice(eq + 1).trim()
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      jar[name] = decodeURIComponent(value)
    } catch {
      jar[name] = value // a stray '%' is not a reason to lose the cookie
    }
  }
  return jar
}

/** The session token this request is carrying, if any. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[SESSION_COOKIE]
}
