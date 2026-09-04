/// <reference types="@cap-js/cds-types" />
/**
 * CAP bootstrap: everything that has to be true of an HTTP request before a service
 * handler ever sees it.
 *
 * `cds.emit('bootstrap', app)` fires on a bare express app, **before** CAP mounts its own
 * CORS shim, its `/health` stub, its `express.static(app/)` and the service routers, and
 * before `cds.middlewares.before` (which CAP mounts per service path, not globally). That
 * ordering is the whole design of this file:
 *
 *   - anything registered here wins over CAP's defaults, because express matches routes in
 *     registration order — which is how `/health` below replaces CAP's `{status:'UP'}`;
 *   - authentication has to live here too, because CAP's auth chain only guards
 *     `/ledger` and `/admin`, and "every request" in this app also means the SPA, the
 *     static assets and the health probe.
 *
 * @see docs/AUTH_BTP.md for the XSUAA alternative to the basic auth below.
 */
import cds from '@sap/cds'
import type { Service } from '@sap/cds'
import bcrypt from 'bcryptjs'

/**
 * Load `.env` into `process.env` before ANY module reads a credential.
 *
 * CAP resolves `.env` into `cds.env` for its own configuration, but it never populates
 * `process.env` — and every credential in this app is read from `process.env` at call
 * time (`getProvider()`, `getDocAiClient()`, the basic-auth hashes). Without this the
 * app boots perfectly happily with an `ANTHROPIC_API_KEY` sitting in `.env`, reports
 * "no LLM credentials configured", and silently serves the deterministic template
 * statement forever. That is the worst class of bug here: it looks like it works.
 *
 * `process.loadEnvFile` is built into Node 20.12+, so this costs no dependency. Real
 * environment variables win over the file, which is what production wants (Fly secrets,
 * BTP service bindings) — so we only set keys that are not already present.
 */
function loadDotEnv(): void {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) return // normal in production, where real env vars are injected
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (key in process.env) continue // a real environment variable always wins
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
loadDotEnv()
import express from 'express'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { MAX_UPLOAD_BYTES } from './lib/images'
import {
  allowAnyCredentials,
  expiredSessionCookie,
  issueSessionToken,
  readSessionToken,
  sessionCookie,
  sessionSecretConfigured,
  verifyCredentials,
  verifySessionToken,
} from './lib/auth'
import { basemapProxy } from './lib/commons/basemap'
import { configureDatabase } from './lib/database'
import { describeProvider } from './lib/llm'
import { migrate, refreshViews } from './lib/migrate'
import {
  addChatListener,
  CHAT_HEARTBEAT_MS,
  chatListenerCount,
  replayChat,
  type ChatEvent,
} from './lib/chat-stream'
import {
  createGroup,
  currentInvite,
  GroupError,
  joinGroup,
  membershipsOf,
  registerUser,
  resolveMembership,
  rotateInvite,
  verifyUser,
  type AccountRow,
} from './lib/groups'
import { readBuildStamp, type BuildStamp } from './lib/build-stamp'
import { getDocAiClient } from './lib/documentai'
import { attachAwards } from './wallet-service'
// Relative rather than '#cds-models/twowaymatch': package.json carries no "imports"
// mapping for that subpath, so the alias resolves at neither compile nor run time.
import { People } from '../@cds-models/twowaymatch'

/**
 * The accounts table, by name rather than through a projection.
 *
 * These routes run before a session names a household, and `LedgerService` narrows every
 * read to one — so they address the base tables directly. `Users` is not exposed through
 * any service in any case: a password hash has no business in an OData projection.
 */
const USERS_TABLE = 'twowaymatch.Users'

const LOG = cds.log('server')

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

/**
 * Paths that belong to the backend and must never be answered with `index.html`.
 *
 * `/ledger` is CONTRACTS.md §1.4, `/admin` is `srv/admin-service.cds`, and the rest are
 * CAP's protocol mounts. They are listed rather than discovered because the SPA fallback
 * is registered at bootstrap, when no service has been served yet and CAP therefore
 * cannot be asked what it is about to mount.
 */
const API_PREFIXES = ['/api', '/health', '/odata', '/rest', '/hcql', '/$api-docs']

/**
 * A JSON body that is not carrying an image. OData payloads for this app are a handful of
 * fields; a megabyte is already two orders of magnitude of headroom.
 */
const MAX_JSON_BODY_BYTES = 1024 * 1024

/**
 * The ceiling on a request that legitimately carries a receipt.
 *
 * `MAX_UPLOAD_BYTES` (10 MB, `srv/lib/images.ts`) is the limit on the *image*. A base64
 * body inflates it by 4/3, and the JSON envelope around it costs a little more, so the
 * HTTP limit has to be the inflated number — otherwise a 9.9 MB photo that
 * `processReceiptImage` would happily accept is rejected by the transport instead, with a
 * far worse error message.
 */
const MAX_UPLOAD_REQUEST_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024

/** Request paths that are allowed to spend `MAX_UPLOAD_REQUEST_BYTES`. */
const UPLOAD_PATHS = /(^|\/)(scanReceipt|image|photos?)(\W|$)/i

/**
 * The two expensive actions, and only those.
 *
 * `scanReceipt` spends SAP Document AI quota and takes seconds; `generateStatement`
 * spends LLM tokens. Everything else in this app is a SQLite read against a table with
 * dozens of rows and does not need a limiter.
 */
const SCAN_PATH = /(^|\/)scanReceipt(\W|$)/i
const STATEMENT_PATH = /(^|\/)generateStatement(\W|$)/i

const HOUR_MS = 60 * 60 * 1000

/**
 * The sign-in limiter: ten attempts per IP per quarter hour.
 *
 * bcrypt at cost 12 already bounds guessing to a few attempts a second per core, so this
 * is not the only thing standing between a stranger and the ledger — it is what stops a
 * script from spending the server's entire CPU budget on that bcrypt, which is the real
 * cost of an unlimited login endpoint. Successful sign-ins do not count against it.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_LIMIT_PER_WINDOW = 10

/** A sign-in body is two short strings. Four kilobytes is already absurd headroom. */
const MAX_LOGIN_BODY_BYTES = 4 * 1024

/** A big shopping day is ten receipts; sixty an hour is a broken client, not a user. */
const SCAN_LIMIT_PER_HOUR = 60

/** Each statement is a full-year LLM call. Ten an hour is already generous. */
const STATEMENT_LIMIT_PER_HOUR = 10

const WEIGHTS_PATH = join(cds.root, 'ml', 'model', 'weights.json')
const DIST_DIR = join(cds.root, 'app', 'dist')
const DIST_INDEX = join(DIST_DIR, 'index.html')
/** Written by the frontend build next to the bundle it stamps — see `app/vite/buildStamp.ts`. */
const BUILD_STAMP_PATH = join(DIST_DIR, 'build.json')

/**
 * A file Vite content-hashed into `app/dist/assets/`, which therefore never goes stale.
 *
 * Matching Vite's actual output takes care: it emits `assets/<name>-<hash><ext>` — the hash
 * joined with a **dash**, and drawn from base64url, so upper case, `-` and `_` all appear
 * in it. The `name.<hex>.ext` shape older bundlers produced never occurs here, and a
 * pattern written for it would match nothing and quietly cost every asset its caching.
 *
 * Both halves are required — the `assets/` directory *and* a hash segment — because the
 * two ways of being wrong are not symmetric. A miss costs one revalidation; a false
 * positive pins a mutable file in somebody's browser for a year.
 */
const IMMUTABLE_ASSET = /[/\\]assets[/\\][^/\\]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/

const isProduction = (): boolean => process.env.NODE_ENV === 'production'

/* ------------------------------------------------------------------ *
 *  The express application
 * ------------------------------------------------------------------ */

/**
 * Everything this app adds to the express instance CAP is about to serve from.
 *
 * Exported so it can be exercised without booting CAP: `test/security.test.ts` mounts it
 * on a bare express app, which keeps the security assertions independent of whether the
 * ledger service happens to compile today.
 */
/**
 * Where the basemap is served from.
 *
 * Under `/api/` so it lands on the same side of every proxy rule, cache rule and auth rule
 * as the rest of the backend, and so Vite's dev proxy forwards it without a new entry.
 */
export const BASEMAP_MOUNT = '/api/basemap'

/**
 * Whether the Places map is Google's rather than ours.
 *
 * Read from the same variable the client build reads, so the two cannot disagree: a CSP that
 * permits Google while the bundle does not use it is a pointlessly weakened policy, and the
 * reverse is a map that silently refuses to load.
 */
function usesGoogleMaps(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim().length > 0
}

/** The hosts the Maps JavaScript API fetches its code, tiles and fonts from. */
const GOOGLE_MAPS_HOSTS = ['https://maps.googleapis.com', 'https://maps.gstatic.com']

export function configureApp(app: express.Application): void {
  app.disable('x-powered-by')

  // Fly.io and Cloud Foundry both put exactly one proxy in front of the app. `true` would
  // trust the whole X-Forwarded-For chain, which lets a client forge `req.ip` and defeat
  // the rate limiter; express-rate-limit refuses to run with that setting for that reason.
  if (isProduction()) app.set('trust proxy', 1)

  app.use(securityHeaders())
  app.use(requestLog)
  app.use(requestSizeGuard)
  app.use(sameOriginCors)

  // Ahead of the guard, and that ordering is the whole point: signing in is the one thing
  // a request that cannot yet authenticate has to be allowed to do.
  mountAuthRoutes(app)

  if (credentials !== null) app.use(requestAuth(credentials))
  app.use(expensiveActionLimits())

  app.get('/health', health)

  // Behind the guard on purpose. The tiles themselves are public data and worth nothing to
  // an attacker, but an unauthenticated proxy is an open proxy: anybody on the internet
  // could serve their own map through this host's bandwidth. Same-origin also means the
  // service worker may cache tiles, which `connect-src 'self'` otherwise forbids.
  app.use(BASEMAP_MOUNT, basemapProxy({ mountedAt: BASEMAP_MOUNT }))

  mountSpa(app)

  app.use(bootstrapErrors)
}

/* ------------------------------------------------------------------ *
 *  1. Security headers
 * ------------------------------------------------------------------ */

/**
 * helmet, with a CSP written for this SPA rather than switched off for it.
 *
 * Each loosening below is a specific thing UI5, Leaflet or the PWA does. The ones that are
 * *not* loosened matter as much: `script-src` stays `'self'` with no `'unsafe-inline'` and
 * no `'unsafe-eval'`, which is the directive that actually stops XSS, and `object-src`,
 * `frame-ancestors` and `base-uri` are all locked down.
 */
function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],

        // No inline and no eval. Vite emits hashed module scripts, UI5 web components
        // register themselves from those modules, and nothing in this app builds code
        // from a string — so the strongest form of this directive is also the correct one.
        //
        // The one exception is opt-in and costs something real. The Google Maps JavaScript
        // API loads its own code at runtime from Google's hosts, so choosing that map means
        // giving up `script-src 'self'` — the directive that actually stops XSS. It is
        // widened only when a key is configured, so a deployment using the default MapLibre
        // map keeps the strong policy. See app/src/pages/places/GoogleMap.tsx.
        scriptSrc: usesGoogleMaps() ? ["'self'", ...GOOGLE_MAPS_HOSTS] : ["'self'"],

        // UI5 web components inject a <style> element per component into the document (and
        // into each shadow root) at runtime, and the React layer sets style attributes for
        // layout. Custom elements have no nonce hook, so 'unsafe-inline' here is the price
        // of the component library. It is the least dangerous of the three classic
        // loosenings: CSS can leak *some* information, it cannot execute.
        styleSrc: ["'self'", "'unsafe-inline'"],

        // 'self' for bundled assets and receipt streams from /ledger; data: because
        // html-to-image renders the shareable statement card to a data URI; blob: because
        // a freshly captured photo is previewed from an object URL before it is uploaded;
        // https: because the Leaflet map pulls raster tiles from a third-party tile host
        // and hard-coding one provider here would break the map the day it is swapped.
        // Images are inert — this permits tracking pixels, not code execution.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],

        // UI5's icon font ships in the bundle; data: covers the small faces Vite inlines.
        // Google's map labels want Roboto from their font host.
        fontSrc: usesGoogleMaps()
          ? ["'self'", 'data:', 'https://fonts.gstatic.com']
          : ["'self'", 'data:'],

        // Same origin only: every backend call goes to /ledger or /admin on this host. A
        // third-party geocoder or tile-metadata API must be proxied through CAP rather
        // than opened up here, so that a compromised bundle has nowhere to send a ledger.
        connectSrc: [
          ...(isProduction() ? ["'self'"] : ["'self'", 'ws:', 'http://localhost:5173']),
          // The Maps API fetches tiles and Places results by XHR. Same opt-in as `scriptSrc`.
          ...(usesGoogleMaps() ? GOOGLE_MAPS_HOSTS : []),
        ],

        // The Workbox service worker from vite-plugin-pwa, which it instantiates from a
        // blob during precaching.
        workerSrc: ["'self'", 'blob:'],

        // The PWA manifest.
        manifestSrc: ["'self'"],

        // Nothing here is embeddable and nothing embeds anything.
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],

        // A <base> injection would repoint every relative URL in the SPA at an attacker.
        baseUri: ["'self'"],

        // Logins post to this origin and nowhere else.
        formAction: ["'self'"],

        // Only meaningful behind TLS; on http://localhost browsers ignore it, but leaving
        // it out of dev keeps the header identical to what the developer reads in the code.
        ...(isProduction() ? { upgradeInsecureRequests: [] } : {}),
      },
    },

    // Receipt images and the statement card are same-origin by construction.
    crossOriginResourcePolicy: { policy: 'same-origin' },

    // helmet's default is SAMEORIGIN, which would contradict `frame-ancestors 'none'`
    // above for the older browsers that only read this header.
    xFrameOptions: { action: 'deny' },

    // A year of HSTS with preload, but only where there is TLS to insist on. Sending it
    // from a dev server would pin http://localhost to https for six months.
    strictTransportSecurity: isProduction()
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,

    // A receipt URL must not leak to a tile server in a Referer header.
    referrerPolicy: { policy: 'no-referrer' },
  })
}

/* ------------------------------------------------------------------ *
 *  2. Request logging
 * ------------------------------------------------------------------ */

/**
 * One line per request, containing nothing that would be embarrassing in a log aggregator.
 *
 * Deliberately absent: the body (receipt contents), the query string (an OData `$filter`
 * carries merchant names), every header (`Authorization` is one), and the user's email —
 * the name of the credential slot they authenticated with is enough to tell two sessions
 * apart and identifies nobody. What is left is method, path, status, duration and size.
 */
function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint()
  // Captured now, not on 'finish': express rewrites `req.url` for a mounted router, so by
  // the time the response ends `req.path` would read `/modelInfo()` instead of
  // `/admin/modelInfo()`. `originalUrl` is untouched — minus its query string, which is
  // where an OData `$filter` full of merchant names would otherwise be.
  const path = req.originalUrl.split('?')[0]

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    const bytes = res.getHeader('content-length') ?? '-'
    const who = authenticated.get(req)?.attr.slot ?? '-'
    LOG.info(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms ${bytes}b ${who}`)
  })
  next()
}

/* ------------------------------------------------------------------ *
 *  3. Request size
 * ------------------------------------------------------------------ */

/**
 * Reject an over-sized request before a byte of it is read.
 *
 * This is the cheap, honest check: it trusts `Content-Length`, so a chunked upload with no
 * length header slips past it — which is exactly why `cds.env.server.body_parser.limit` is
 * set as well, and why `processReceiptImage` re-checks the decoded buffer. Three limits at
 * three layers, each one the right tool for a different lie a client can tell.
 */
function requestSizeGuard(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.headers['content-length'])
  if (!Number.isFinite(declared)) return next()

  const limit = UPLOAD_PATHS.test(req.path) ? MAX_UPLOAD_REQUEST_BYTES : MAX_JSON_BODY_BYTES
  if (declared <= limit) return next()

  res.status(413).json({
    error: {
      code: 'payload_too_large',
      message: `request body is ${declared} bytes; the limit for ${req.path} is ${limit}`,
    },
  })
}

/* ------------------------------------------------------------------ *
 *  4. CORS, locked to same origin
 * ------------------------------------------------------------------ */

/**
 * No cross-origin request is ever answered, and no `Access-Control-Allow-Origin` is ever
 * emitted for a foreign origin.
 *
 * The SPA is served from this same origin in production, so it needs no CORS headers at
 * all. Rejecting a foreign `Origin` outright — rather than just declining to send the
 * header, which is all CORS technically requires — also closes the CSRF hole that HTTP
 * basic auth opens: a browser attaches cached basic credentials to a cross-site form POST,
 * and a form POST is not subject to a preflight.
 *
 * In development the Vite dev server on :5173 proxies `/ledger`, but a proxy that does not
 * rewrite `Origin` still sends the browser's, so that one origin is allowed there and only
 * there.
 */
function sameOriginCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Vary', 'Origin')

  const origin = req.headers.origin
  // No Origin at all: a top-level navigation, curl, or a health probe. Nothing to allow.
  if (typeof origin !== 'string' || origin.length === 0) return next()

  const host = req.headers.host ?? ''
  const scheme = req.protocol
  const sameOrigin = origin === `${scheme}://${host}`
  const devOrigin = !isProduction() && isDevOrigin(origin)

  if (!sameOrigin && !devOrigin) {
    res.status(403).json({
      error: { code: 'cross_origin_denied', message: 'this API only answers its own origin' },
    })
    return
  }

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept')
    res.setHeader('Access-Control-Max-Age', '600')
    res.status(204).end()
    return
  }
  next()
}

/**
 * Is this a development origin — the Vite dev server, on this machine or this LAN?
 *
 * A fixed allow-list of ports was wrong twice over. Vite takes the next free port when
 * 5173 is busy (it landed on 5180 on this machine, and every POST then failed with 403
 * while GETs sailed through, because only state-changing requests carry an `Origin` the
 * browser will not let us forge). And testing the app on a phone means the origin is the
 * Mac's LAN address, which no hard-coded list can know in advance.
 *
 * So in development any loopback or RFC-1918 private address is accepted on any port.
 * This is gated on `!isProduction()` by the single caller and never widens production,
 * where the SPA is served from this very origin and needs no CORS at all.
 */
function isDevOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false // an unparseable Origin is not one we are going to trust
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]')
    return true

  // RFC 1918 private ranges, so a phone on the same Wi-Fi can reach the dev server.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 === null) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if ([a, b, Number(v4[3]), Number(v4[4])].some(n => n > 255)) return false
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/* ------------------------------------------------------------------ *
 *  5. Rate limits on the two expensive actions
 * ------------------------------------------------------------------ */

/**
 * A limiter for `scanReceipt`, a limiter for `generateStatement`, and nothing else.
 *
 * A blanket limiter on a two-person app would only ever fire on the owners: the SPA issues
 * a dozen OData reads to paint one screen. These two actions are different because each
 * one costs money at a third party, so the limit protects a quota and a bill rather than a
 * CPU.
 *
 * The match is on the request path, which means an action wrapped inside an OData `$batch`
 * would slip past — the URL is then `/ledger/$batch` and the action name lives in the
 * multipart body. The SPA calls both of these directly, so this is a documented edge and
 * not a hole worth parsing multipart bodies in a middleware to close; the provider-side
 * quota is the backstop.
 */
function expensiveActionLimits(): RequestHandler {
  const scans = actionLimiter(SCAN_LIMIT_PER_HOUR, 'receipt scans')
  const statements = actionLimiter(STATEMENT_LIMIT_PER_HOUR, 'statement generations')

  return (req, res, next) => {
    if (SCAN_PATH.test(req.path)) return scans(req, res, next)
    if (STATEMENT_PATH.test(req.path)) return statements(req, res, next)
    next()
  }
}

function actionLimiter(limit: number, what: string): RequestHandler {
  return rateLimit({
    windowMs: HOUR_MS,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Per person once authenticated, so one person burning through the quota does not
    // lock everybody else out. `ipKeyGenerator` normalises IPv6 to a /56, which is what keeps a
    // client from walking through a whole address block for a fresh budget.
    keyGenerator: req => authenticated.get(req)?.id ?? ipKeyGenerator(req.ip ?? 'unknown'),
    message: {
      error: {
        code: 'rate_limited',
        message: `too many ${what} in the last hour — the limit is ${limit}`,
      },
    },
  })
}

/* ------------------------------------------------------------------ *
 *  6. /health
 * ------------------------------------------------------------------ */

interface HealthPayload {
  status: 'ok'
  version: string
  uptime: number
  /** `trainedAt` from `ml/model/weights.json`, or null when no model is deployed. */
  model: string | null
  docai: 'live' | 'mock' | 'llm'
  llm: string
  /**
   * The frontend build being served — `app/dist/build.json`, or null before the first
   * build. The Version card compares it with the stamp inside the bundle a device loaded.
   */
  build: BuildStamp | null
  /** How many browsers are holding a chat stream open. Useful when one says nothing arrives. */
  chatListeners: number
}

/**
 * What is running, in a form that is safe to hand to a monitoring probe.
 *
 * Every field here is a *description* of a credential, never one: `describeProvider()`
 * names the environment variable a key came from and strips userinfo and query strings
 * from any URL it prints, and the Document AI mode is a two-valued enum. `test/
 * security.test.ts` asserts that with every secret in the environment set to a known
 * sentinel, none of them appears in this response.
 */
function health(_req: Request, res: Response): void {
  const payload: HealthPayload = {
    status: 'ok',
    version: packageVersion,
    uptime: Math.round(process.uptime()),
    model: modelTrainedAt(),
    docai: getDocAiClient().mode,
    llm: describeProvider(),
    chatListeners: chatListenerCount(),
    build: readBuildStamp(BUILD_STAMP_PATH),
  }
  // A cached health check is a lie about the present.
  res.setHeader('Cache-Control', 'no-store')
  res.json(payload)
}

const packageVersion = readPackageVersion()

function readPackageVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cds.root, 'package.json'), 'utf8'))
    const version =
      typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * `trainedAt` out of `weights.json`, cached against the file's mtime.
 *
 * The file is ~5 MB of base64 coefficients; parsing it per request would turn a health
 * probe into the slowest endpoint in the app. Keying the cache on mtime rather than just
 * caching once means a retrain is visible on the next probe without a restart.
 *
 * `srv/admin-service.ts` reads the same file for the full metadata and deliberately does
 * not share this function: `/health` must keep answering even on the day the admin service
 * fails to load.
 */
function modelTrainedAt(): string | null {
  try {
    const { mtimeMs } = statSync(WEIGHTS_PATH)
    if (weightsCache !== null && weightsCache.mtimeMs === mtimeMs) return weightsCache.trainedAt

    const raw: unknown = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf8'))
    const trainedAt =
      typeof raw === 'object' && raw !== null
        ? (raw as { trainedAt?: unknown }).trainedAt
        : undefined
    const value = typeof trainedAt === 'string' ? trainedAt : null
    weightsCache = { mtimeMs, trainedAt: value }
    return value
  } catch {
    // No model deployed yet, or an unreadable one. Not a reason to fail a health check —
    // the classifier is one feature, and `model: null` says so plainly.
    return null
  }
}

let weightsCache: { mtimeMs: number; trainedAt: string | null } | null = null

/* ------------------------------------------------------------------ *
 *  7. Production HTTP basic auth
 * ------------------------------------------------------------------ */

interface Account {
  /** The login, exactly as configured. Matched against `People.email`. */
  username: string
  /** A bcrypt hash — `$2a$`, `$2b$` or `$2y$`. Never logged, never returned. */
  hash: string
  /**
   * The suffix of the variables this login came from — the `A` of `AUTH_USER_A`.
   * It names a slot in the configuration, never a person: it lands in
   * `req.user.attr.slot` and in the request log, where an email would be an
   * identifier and a person's name would be a guess.
   */
  slot: string
  variable: string
}

interface Credentials {
  accounts: readonly Account[]
  /**
   * A bcrypt hash of a random string nobody knows, verified against whenever the username
   * does not match. Without it, an unknown username returns in microseconds and a known
   * one in a quarter of a second, which is a free username oracle.
   */
  decoyHash: string
}

/** Request → the user it authenticated as. A WeakMap rather than a property bolted onto
 *  `express.Request`, so nothing else in the program has to know this field exists. */
const authenticated = new WeakMap<Request, cds.User>()

const BCRYPT_HASH = /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/

/**
 * Every `AUTH_USER_<slot>` / `AUTH_HASH_<slot>` pair the environment mentions, sorted.
 *
 * Discovered rather than hard-coded, because the ledger no longer has a fixed number of
 * people in it (CONTRACTS.md §10): `AUTH_USER_A` and `AUTH_USER_B` are two ordinary
 * slots, and adding `AUTH_USER_C` adds a third login without a code change. A variable
 * that is *defined and empty* still names a slot, so a half-filled configuration is
 * reported as the mistake it is instead of silently vanishing.
 */
function credentialSlots(): string[] {
  const slots = new Set<string>()
  for (const name of Object.keys(process.env)) {
    const match = /^AUTH_(?:USER|HASH)_([A-Za-z0-9_]+)$/.exec(name)
    if (match !== null) slots.add(match[1])
  }
  return [...slots].sort()
}

/**
 * Read the `AUTH_*` variables, or refuse to start.
 *
 * The alternative to throwing here is a production deployment that serves a household's
 * entire financial history to the internet, because CAP's configured `auth.kind` is
 * `mocked` and its default mocked-user table ends in `'*': true` — "any username, any
 * password". A missing environment variable must not be able to turn that back on.
 */
function loadCredentials(): Credentials {
  const accounts: Account[] = []
  const problems: string[] = []
  const slots = credentialSlots()
  const openDoor = allowAnyCredentials()

  // With AUTH_ALLOW_ANY set, having no configured login is the intended state rather than
  // the deployment mistake this function otherwise refuses to start on. A slot that *is*
  // present is still validated, so a half-written AUTH_HASH_A is caught either way.
  if (slots.length === 0 && !openDoor) {
    problems.push(
      'no login is configured — set AUTH_USER_A and AUTH_HASH_A, plus a further pair for ' +
        'every other person who signs in',
    )
  }

  for (const slot of slots) {
    const userVariable = `AUTH_USER_${slot}`
    const hashVariable = `AUTH_HASH_${slot}`
    const username = (process.env[userVariable] ?? '').trim()
    const hash = (process.env[hashVariable] ?? '').trim()

    if (username.length === 0) problems.push(`${userVariable} is empty`)
    if (hash.length === 0) problems.push(`${hashVariable} is empty`)
    else if (!BCRYPT_HASH.test(hash)) {
      problems.push(
        `${hashVariable} is not a bcrypt hash — generate one with \`npm run hash\` and ` +
          'quote it with SINGLE quotes in .env, so the $ signs survive the parser',
      )
    }
    if (username.length > 0 && hash.length > 0 && BCRYPT_HASH.test(hash)) {
      accounts.push({ username, hash, slot, variable: userVariable })
    }
  }

  // Two slots sharing a login is not a second person, it is a typo — and a silent one,
  // because whichever slot is compared last would quietly own every session.
  const repeated = accounts.find((account, index) =>
    accounts.some((other, before) => before < index && other.username === account.username),
  )
  if (repeated !== undefined) {
    problems.push(`${repeated.variable} repeats a login another AUTH_USER_* already uses`)
  }

  if (problems.length > 0) {
    throw new Error(
      `refusing to start in production without working credentials:\n  - ${problems.join(
        '\n  - ',
      )}\nSee section 5 of .env.example.`,
    )
  }

  // The decoy keeps a wrong username costing the same as a wrong password. Open-door mode
  // can reach here with nothing configured, and there is then no reference hash to copy a
  // cost factor from, so one is minted at the same cost the project hashes at.
  const reference = accounts[0]?.hash
  return {
    accounts,
    decoyHash:
      reference === undefined
        ? bcrypt.hashSync(randomBytes(32).toString('hex'), 12)
        : makeDecoyHash(reference),
  }
}

/**
 * The same variables, read leniently, for a process that is not production.
 *
 * Development has always been wide open, and with nothing configured it stays that way —
 * `null` here means no guard is mounted and every request is allowed, which is what makes
 * `npm run dev` work against an empty `.env`.
 *
 * What it adds is that a developer who *does* configure a login gets the real thing:
 * the sign-in screen, the cookie, the guard. Otherwise the one flow this change is about
 * would be unreachable outside a production deployment. Half-configured slots are skipped
 * in silence rather than thrown on — on a laptop a stray `AUTH_HASH_A` is a leftover, and
 * in production {@link loadCredentials} already refuses to start on exactly that.
 */
function optionalCredentials(): Credentials | null {
  const accounts: Account[] = []
  for (const slot of credentialSlots()) {
    const variable = `AUTH_USER_${slot}`
    const username = (process.env[variable] ?? '').trim()
    const hash = (process.env[`AUTH_HASH_${slot}`] ?? '').trim()
    if (username === '' || !BCRYPT_HASH.test(hash)) continue
    if (accounts.some(account => account.username === username)) continue
    accounts.push({ username, hash, slot, variable })
  }
  if (accounts.length === 0) return null

  LOG.info(
    `sign-in is required for ${accounts.length} configured login(s) ` +
      `(${accounts.map(account => account.variable).join(', ')})`,
  )
  // The decoy keeps a wrong username costing the same as a wrong password. Open-door mode
  // can reach here with nothing configured, and there is then no reference hash to copy a
  // cost factor from, so one is minted at the same cost the project hashes at.
  const reference = accounts[0]?.hash
  return {
    accounts,
    decoyHash:
      reference === undefined
        ? bcrypt.hashSync(randomBytes(32).toString('hex'), 12)
        : makeDecoyHash(reference),
  }
}

/**
 * A hash of 32 random bytes, at the same cost factor as the real ones so that verifying
 * against it takes the same time. Costs one bcrypt round at startup, once.
 */
/**
 * The account open-door mode authenticates as: whatever name was typed, and no hash.
 *
 * The empty `hash` is never compared against — nothing reaches bcrypt on this path — and
 * the `ANY` slot is what shows up in the request log, so a glance at the log says which
 * requests came in through the open door rather than through a configured login.
 */
function openDoorAccount(username: string): Account {
  return { username: username.trim(), hash: '', slot: 'ANY', variable: 'AUTH_ALLOW_ANY' }
}

function makeDecoyHash(reference: string): string {
  const rounds = bcrypt.getRounds(reference)
  return bcrypt.hashSync(randomBytes(32).toString('hex'), rounds)
}

/**
 * The bootstrap-phase guard: every request, including the SPA and `/health`.
 *
 * Two ways in, in this order.
 *
 *  1. **The session cookie.** One HMAC verification, no bcrypt, no password on the wire.
 *     This is what the browser uses after somebody has signed in once.
 *  2. **HTTP basic auth**, byte for byte the check this file has always done. curl,
 *     monitoring probes and every deployment that predates the cookie keep working, and
 *     `docs/API.md` stays true.
 *
 * What is deliberately *not* guarded is the SPA shell — see {@link isPublicShell}. Without
 * that exception there is nowhere to render a sign-in form, and the browser falls back to
 * the chrome-drawn basic-auth popup, which is the thing the cookie exists to replace.
 *
 * Brute forcing through basic auth is bounded by bcrypt itself — cost 12 is roughly four
 * guesses per second per core. The sign-in endpoint, which a script would actually target,
 * has its own limiter.
 */
function requestAuth(config: Credentials): RequestHandler {
  return (req, res, next) => {
    void identify(req, config)
      .then(account => {
        if (account !== null) {
          authenticated.set(
            req,
            new cds.User({
              id: account.username,
              // `admin` is the only role anything in this app checks
              // (`srv/admin-service.cds`), and everybody who can sign in is trusted with
              // the whole ledger: there is no privilege boundary to draw between people
              // who share a bank account.
              roles: ['admin'],
              // Which configured login this is, for the request log. Not a person.
              attr: { slot: account.slot },
            }),
          )
          return next()
        }
        if (isPublicShell(req)) return next()
        challenge(res)
      })
      .catch(next)
  }
}

/**
 * The account this request proves it is, or `null`.
 *
 * The cookie is checked first because it is the cheap path and the common one. A valid
 * signature only proves *this deployment* minted the token, so the username is still looked
 * up in the configured accounts: pulling `AUTH_USER_C` out of the environment has to end
 * that person's sessions, not merely stop them signing in again.
 *
 * The basic-auth half below is unchanged: every account is compared with no early exit, and
 * exactly one bcrypt verification runs either way, so a wrong username costs the same as a
 * wrong password and the endpoint is not a username oracle.
 */
async function identify(
  req: Request,
  { accounts, decoyHash }: Credentials,
): Promise<Account | null> {
  const openDoor = allowAnyCredentials()

  const session = verifySessionToken(readSessionToken(req.headers.cookie))
  if (session !== null) {
    const account = accounts.find(entry => entry.username === session.username)
    if (account !== undefined) return account
    // A registered account (TWM-ADR-002 phase 1). Its username is an email address that
    // will never appear in AUTH_*, so matching against the configured logins can only
    // ever fail -- which meant somebody could register, create a household, and be
    // bounced straight back to the sign-in form. The `uid` claim is what distinguishes
    // it, and the signature already proves this deployment minted the token.
    if (session.userId != null && session.userId !== '') {
      return openDoorAccount(session.username)
    }
    // The token's signature already proves this deployment minted it, so in open-door mode
    // the name it carries is simply the name this browser signed in as.
    if (openDoor) return openDoorAccount(session.username)
  }

  const offered = parseBasic(req.headers.authorization)
  if (offered === null) return null

  let matched: Account | null = null
  for (const account of accounts) {
    if (constantTimeEquals(account.username, offered.username)) matched = account
  }

  const ok = await bcrypt.compare(offered.password, matched?.hash ?? decoyHash)
  if (ok && matched !== null) return matched

  // Configured logins get first refusal above, so a real credential still resolves to its
  // own slot and its own Person; only what they reject falls through to here.
  if (openDoor && offered.username.trim() !== '' && offered.password !== '') {
    return openDoorAccount(offered.username)
  }
  return null
}

/**
 * Requests that are answered to a signed-out browser: the SPA shell and its assets.
 *
 * This is exactly the surface {@link mountSpa} serves — `index.html`, the hashed bundles,
 * the manifest, the service worker — and nothing else. Every path carrying ledger data is
 * under one of the `API_PREFIXES` (`/api/ledger` and `/api/admin` are both under `/api`,
 * and `/health` names what is running), so it stays behind the guard.
 *
 * It has to be public, because a sign-in form has to be *served* before anyone can sign in.
 * A 401 on a top-level navigation is what makes a browser draw its own credential dialog,
 * and that dialog is the thing this app is replacing. The shell contains no data: it is a
 * bundle that then calls `/api/auth/me` and finds out whether it may ask for anything.
 */
function isPublicShell(req: Request): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(req.path)
}

function challenge(res: Response): void {
  res
    .status(401)
    .set('WWW-Authenticate', 'Basic realm="Two-Way Match", charset="UTF-8"')
    .json({ error: { code: 'unauthenticated', message: 'this ledger is private' } })
}

interface Offered {
  username: string
  password: string
}

function parseBasic(header: string | undefined): Offered | null {
  if (typeof header !== 'string' || !/^basic /i.test(header)) return null
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

/**
 * Compare two strings without leaking their contents *or* their lengths through timing.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, and catching that
 * would itself be a length oracle, so both sides are hashed to a fixed 32 bytes first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/**
 * Hand the user authenticated at bootstrap to CAP, by taking over the slot in
 * `cds.middlewares.before` that CAP's own auth strategy occupies.
 *
 * Replacing the slot rather than adding a middleware next to it is deliberate: the
 * configured strategy is `mocked`, whose default user table ends in `'*': true`. Adding to
 * the chain would leave that strategy running; replacing it means it cannot run at all.
 * If the slot is not where it is expected, this throws and the server does not start —
 * the one acceptable failure mode for a change to an auth chain.
 */
function installProductionAuth(config: Credentials): void {
  const chain = cds.middlewares as unknown as {
    auth: unknown
    before: (RequestHandler & { factory?: unknown })[]
  }
  const slot = chain.before.findIndex(mw => mw.factory === chain.auth)
  if (slot < 0) {
    throw new Error(
      "cannot find CAP's auth middleware in cds.middlewares.before — refusing to start " +
        'rather than serve the ledger with the mocked auth strategy still in place',
    )
  }

  const adopt: RequestHandler = (req, _res, next) => {
    const user = authenticated.get(req)
    // Unreachable: `requestAuth` runs first, and every path CAP mounts a service on is an
    // API path, so it either sets this or answers 401 itself — the public-shell exception
    // cannot reach here. Belt and braces: the cost of being wrong is the whole ledger.
    if (user === undefined)
      return next(Object.assign(new Error('unauthenticated'), { status: 401 }))
    const context = cds.context
    if (context !== undefined) context.user = user
    Object.assign(req, { user })
    next()
  }

  chain.before[slot] = Object.assign(adopt, { factory: chain.auth })

  if (allowAnyCredentials()) {
    // Loud, every boot, and deliberately not a one-liner. Anyone reading this log should be
    // able to tell in one glance that the ledger is open, and how to close it.
    LOG.warn(
      'AUTH_ALLOW_ANY is set: ANY username and password will be accepted. Everything in ' +
        'this ledger is readable and writable by anyone who has the URL. ' +
        `${config.accounts.length} configured login(s) still resolve to their own Person; ` +
        'unset AUTH_ALLOW_ANY to require them.',
    )
    return
  }

  LOG.info(
    `production basic auth active for ${config.accounts.length} logins ` +
      `(${config.accounts.map(a => a.variable).join(', ')}); CAP's mocked strategy replaced`,
  )
}

/**
 * Warn — once, at startup — when a configured login matches nobody in `People`.
 *
 * The bridge between a login and the ledger is `People.email` (CONTRACTS.md §10). A login
 * that matches no row still authenticates, so the app works — but whoever signs in with it
 * is nobody the ledger has heard of, and every screen that offers to attribute a posting
 * to "you" has nothing to offer. This is a warning rather than a refusal because the rows
 * are editable at runtime through Settings, so the fix does not need a redeploy.
 */
async function verifyLoginMapping(): Promise<void> {
  if (credentials === null) return
  try {
    const rows = (await SELECT.from(People).columns('email')) as unknown as {
      email: string | null
    }[]
    // Case-folded on both sides: identity providers and humans are inconsistent about the
    // case of the local part, and `Anna@example.com` failing to match `anna@example.com`
    // is a spectacularly boring bug to debug.
    const known = new Set(
      rows.map(row => (row.email ?? '').trim().toLowerCase()).filter(email => email !== ''),
    )
    for (const account of credentials.accounts) {
      if (!known.has(account.username.toLowerCase())) {
        LOG.warn(
          `${account.variable} matches no People row by email — add that person in Settings, ` +
            'or point the variable at an address the ledger knows',
        )
      }
    }
  } catch (error) {
    LOG.warn('could not check the AUTH_USER_* → People mapping:', message(error))
  }
}

/* ------------------------------------------------------------------ *
 *  7b. Sessions: sign in, sign out, who am I
 * ------------------------------------------------------------------ */

/**
 * The three endpoints the SPA boots on, mounted ahead of {@link requestAuth}.
 *
 * `express.json()` is scoped to the one route that needs it rather than applied globally:
 * at bootstrap CAP has not mounted its own body parsers yet, and a global JSON parser here
 * would consume the request stream of every OData call before the protocol adapter that
 * knows how to read it ever saw one.
 */
function mountAuthRoutes(app: express.Application): void {
  const body = express.json({ limit: MAX_LOGIN_BODY_BYTES })

  app.post('/api/auth/login', loginLimiter(), body, (req, res, next) => {
    void authLogin(req, res).catch(next)
  })

  app.post('/api/auth/logout', (_req, res) => {
    // Unconditional, and never an error: signing out a request that was not signed in is
    // exactly what a user who is not sure means by it.
    res.setHeader('Set-Cookie', expiredSessionCookie())
    res.setHeader('Cache-Control', 'no-store')
    res.status(204).end()
  })

  app.get('/api/auth/me', (req, res, next) => {
    void authMe(req, res).catch(next)
  })

  mountGroupRoutes(app)
  mountChatStream(app)
}

/* ------------------------------------------------------------------ *
 *  Accounts and households  (TWM-ADR-002 phase 1)
 * ------------------------------------------------------------------ */

/**
 * Sign-up, create-a-household and join-a-household.
 *
 * These sit beside the existing `/api/auth/*` rather than inside `LedgerService`, for the
 * same reason `login` does: they all run *before* a caller has a household, and every read
 * in that service is narrowed to one. They are also the only writes in the app that must
 * reach the base tables directly.
 *
 * All three re-issue the session cookie, because the group claim is what the rest of the
 * app scopes on. Forgetting that is a subtle bug: everything appears to work until the
 * next request resolves to the wrong household.
 */
function mountGroupRoutes(app: express.Application): void {
  const body = express.json({ limit: MAX_LOGIN_BODY_BYTES })

  app.post('/api/auth/register', loginLimiter(), body, (req, res, next) => {
    void handleGroupRoute(res, async () => {
      const account = await registerUser({
        email: value(req.body, 'email'),
        password: value(req.body, 'password'),
        displayName: value(req.body, 'displayName'),
      })
      // Signed in immediately: an account with no household yet is exactly the state the
      // next screen is for, and making them type the password again proves nothing.
      issueFor(res, account.email, { userId: account.ID, groupId: null })
      return { user: publicAccount(account), memberships: [] }
    }).catch(next)
  })

  app.post('/api/auth/login-account', loginLimiter(), body, (req, res, next) => {
    void handleGroupRoute(res, async () => {
      const account = await verifyUser(value(req.body, 'email'), value(req.body, 'password'))
      if (account === null) {
        throw new GroupError(401, 'that email and password do not match')
      }
      const memberships = await membershipsOf(account.ID)
      issueFor(res, account.email, {
        userId: account.ID,
        groupId: memberships[0]?.groupId ?? null,
      })
      return { user: publicAccount(account), memberships }
    }).catch(next)
  })

  app.post('/api/groups/create', body, (req, res, next) => {
    void handleGroupRoute(res, async () => {
      const account = await requireAccount(req)
      const created = await createGroup({
        userId: account.ID,
        displayName: account.displayName ?? account.email,
        name: value(req.body, 'name'),
        kind: value(req.body, 'kind'),
        currency: value(req.body, 'currency'),
      })
      issueFor(res, account.email, { userId: account.ID, groupId: created.groupId })
      return { group: created }
    }).catch(next)
  })

  app.post('/api/groups/join', body, (req, res, next) => {
    void handleGroupRoute(res, async () => {
      const account = await requireAccount(req)
      const joined = await joinGroup({
        userId: account.ID,
        displayName: account.displayName ?? account.email,
        code: value(req.body, 'code'),
      })
      issueFor(res, account.email, { userId: account.ID, groupId: joined.groupId })
      return { group: joined }
    }).catch(next)
  })

  app.post('/api/groups/switch', body, (req, res, next) => {
    void handleGroupRoute(res, async () => {
      const account = await requireAccount(req)
      const wanted = value(req.body, 'groupId')
      const membership = await resolveMembership(
        account.ID,
        typeof wanted === 'string' ? wanted : null,
      )
      if (membership === null) throw new GroupError(404, 'you are not in that household')
      issueFor(res, account.email, { userId: account.ID, groupId: membership.groupId })
      return { group: membership }
    }).catch(next)
  })

  /** The code to read out, minted on demand. Owners only — it is an open door. */
  app.post('/api/groups/invite', body, (req, res, next) => {
    void handleGroupRoute(res, async () => {
      const account = await requireAccount(req)
      const session = verifySessionToken(readSessionToken(req.headers.cookie))
      const membership = await resolveMembership(account.ID, session?.groupId ?? null)
      if (membership === null) throw new GroupError(404, 'you are not in a household yet')
      if (membership.role !== 'owner') {
        throw new GroupError(403, 'only an owner can invite somebody')
      }
      const rotate = value(req.body, 'rotate') === true
      const invite = rotate
        ? await rotateInvite(membership.groupId)
        : await currentInvite(membership.groupId)
      return { invite }
    }).catch(next)
  })
}

/** One shape for every reply, and one place errors become status codes. */
async function handleGroupRoute(
  res: Response,
  work: () => Promise<Record<string, unknown>>,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store')
  try {
    res.json(await work())
  } catch (error) {
    if (error instanceof GroupError) {
      res.status(error.status).json({ error: { code: 'group_error', message: error.message } })
      return
    }
    // Never leak an internal message to a sign-up form.
    LOG.error('group route failed', error instanceof Error ? error.message : String(error))
    res.status(500).json({
      error: { code: 'server_error', message: 'something went wrong — please try again' },
    })
  }
}

/** The account behind the current session, or a 401 written for a person. */
async function requireAccount(req: Request): Promise<AccountRow> {
  const session = verifySessionToken(readSessionToken(req.headers.cookie))
  if (session?.userId == null) throw new GroupError(401, 'sign in first')
  const row = (await SELECT.one
    .from(USERS_TABLE)
    .columns('ID', 'email', 'displayName')
    .where({ ID: session.userId })) as AccountRow | null | undefined
  // `== null`: CAP answers `undefined` for no match, and a strict check would let a
  // deleted account keep a working session.
  if (row == null) throw new GroupError(401, 'sign in first')
  return row
}

/** Mint the cookie with both claims. Every route above ends by calling this. */
function issueFor(
  res: Response,
  username: string,
  claims: { userId: string; groupId: string | null },
): void {
  res.setHeader('Set-Cookie', sessionCookie(issueSessionToken(username, Date.now(), claims)))
}

/** An account as the client may see it: never the hash. */
function publicAccount(account: AccountRow): Record<string, unknown> {
  return { id: account.ID, email: account.email, displayName: account.displayName }
}

function value(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[key]
}

/**
 * `GET /api/chat/stream` — server-sent events for the caller's household.
 *
 * The response never ends: it is held open, written to when somebody says something, and
 * closed only when the browser goes away. Three things that are easy to get wrong and are
 * done deliberately here:
 *
 *  - **`X-Accel-Buffering: no`.** A reverse proxy that buffers will hold events until its
 *    buffer fills, which turns a live thread into one that updates every few minutes. Fly's
 *    proxy honours this header, and so does nginx if one ever sits in front.
 *  - **A heartbeat comment.** An idle connection is closed by proxies and by phones going
 *    to sleep; a `:` line every 25 seconds keeps it alive and costs two bytes.
 *  - **`Last-Event-ID`.** The browser sends it on reconnect, and anything still in the
 *    replay window is delivered rather than missed, so a tunnel dropping does not silently
 *    lose a message.
 *
 * Events carry ids only — the client fetches what changed through the ordinary
 * group-scoped read, which is what keeps authorisation in one place.
 */
function mountChatStream(app: express.Application): void {
  app.get('/api/chat/stream', (req, res, next) => {
    void streamChat(req, res).catch(next)
  })
}

async function streamChat(req: Request, res: Response): Promise<void> {
  const session = verifySessionToken(readSessionToken(req.headers.cookie))
  const account = credentials === null ? null : await identify(req, credentials)
  if (credentials !== null && account === null) {
    res.status(401).json({ error: { code: 'unauthenticated', message: 'sign in first' } })
    return
  }

  // Which household to listen to. An account session names it; anything else — the
  // configured AUTH_* logins, or the open door — belongs to the seeded household, which
  // is what `LedgerService` resolves such a request to as well.
  const groupId = session?.groupId ?? (await defaultGroupId())
  if (groupId === null) {
    res.status(404).json({ error: { code: 'no_household', message: 'no household to listen to' } })
    return
  }

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const write = (event: ChatEvent): void => {
    res.write(`id: ${event.id}\n`)
    res.write(`event: message\n`)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // Anything missed while the connection was down, before anything new.
  const lastSeen = Number(req.headers['last-event-id'] ?? 0)
  if (Number.isFinite(lastSeen) && lastSeen > 0) {
    for (const missed of replayChat(groupId, lastSeen)) write(missed)
  }
  res.write(': listening\n\n')

  const remove = addChatListener({ groupId, send: write })
  const heartbeat = setInterval(() => {
    // A comment line: ignored by EventSource, enough to keep a proxy from closing us.
    res.write(': ping\n\n')
  }, CHAT_HEARTBEAT_MS)

  const close = (): void => {
    clearInterval(heartbeat)
    remove()
  }
  req.on('close', close)
  req.on('error', close)
}

/** The seeded household, for a listener whose session names none. */
async function defaultGroupId(): Promise<string | null> {
  try {
    const rows = (await SELECT.from('twowaymatch.Groups')
      .columns('ID')
      .where({ isDefault: true })) as Array<{ ID?: string }>
    const marked = rows.map(row => String(row.ID)).sort()[0]
    return marked ?? null
  } catch {
    return null
  }
}

/**
 * A limiter on sign-in attempts, per IP.
 *
 * Keyed by address rather than by the offered username on purpose: keying on the username
 * would let a stranger exhaust somebody else's budget and lock them out of their own
 * ledger. `ipKeyGenerator` normalises IPv6 to a /56, so a client cannot walk an address
 * block for a fresh budget. Built per `configureApp` call so each app carries its own
 * store.
 */
function loginLimiter(): RequestHandler {
  return rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_LIMIT_PER_WINDOW,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(req.ip ?? 'unknown'),
    // Only failures cost. Somebody signing in on a phone and a laptop on the same evening
    // is not what this is for.
    skipSuccessfulRequests: true,
    message: {
      error: {
        code: 'rate_limited',
        message: 'too many sign-in attempts — wait a few minutes and try again',
      },
    },
  })
}

/** `POST /api/auth/login` — `{username, password}` in, a session cookie and `{name}` out. */
async function authLogin(req: Request, res: Response): Promise<void> {
  const payload: unknown = req.body
  const account = await verifyCredentials(field(payload, 'username'), field(payload, 'password'))

  res.setHeader('Cache-Control', 'no-store')

  if (account === null) {
    // One message for every failure. A wrong password, a login nobody configured and a
    // server with no logins at all must be indistinguishable from out here.
    res.status(401).json({
      error: { code: 'invalid_credentials', message: 'that username and password do not match' },
    })
    return
  }

  res.setHeader('Set-Cookie', sessionCookie(issueSessionToken(account.username)))
  // The name the ledger knows this person by, so the SPA can greet them without a second
  // round trip. Falls back to the login itself when the roster has no matching row.
  res.json({ name: (await rosterEntry(account.username))?.name ?? account.username })
}

function field(payload: unknown, key: 'username' | 'password'): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[key]
}

interface MePayload {
  authenticated: boolean
  username: string | null
  personId: string | null
  personName: string | null
  /** Null until the account joins or creates a household — the SPA routes on exactly this. */
  userId: string | null
  groupId: string | null
  groupName: string | null
  /** The preset the household was created with — copy for the Settings card, never logic. */
  kind: string | null
  role: 'owner' | 'member' | null
  /** Every household this account belongs to, so the switcher needs no second request. */
  memberships: Array<{ groupId: string; groupName: string; role: string; personName: string }>
}

/**
 * `GET /api/auth/me` — **always 200**, which is the entire contract.
 *
 * The SPA calls this on boot to decide whether to show the app or the sign-in screen. A 401
 * here would be answered by the browser's own credential dialog on some paths and by an
 * error boundary on others, and either way the app would have to guess.
 *
 * With no `AUTH_*` configured — a laptop running `npm run dev` — this reports
 * `authenticated: true` with the first `isDefault` person, because that is exactly what the
 * server does: no guard is mounted and every request is allowed. Reporting anything else
 * would send a developer to a sign-in screen that no password can get past.
 */
async function authMe(req: Request, res: Response): Promise<void> {
  const config = credentials
  const account = config === null ? null : await identify(req, config)
  const signedIn = config === null || account !== null
  const who = signedIn ? await rosterEntry(account?.username ?? null) : null

  // An account-based session knows more than a configured-login one: which household it
  // is looking at, what it is called, and which others it could switch to. A session from
  // the AUTH_* logins has none of that and falls back to the roster, exactly as before.
  const session = verifySessionToken(readSessionToken(req.headers.cookie))
  let membership: Awaited<ReturnType<typeof resolveMembership>> = null
  let memberships: MembershipSummary[] = []
  if (session?.userId != null) {
    try {
      const all = await membershipsOf(session.userId)
      memberships = all.map(view => ({
        groupId: view.groupId,
        groupName: view.groupName,
        role: view.role,
        personName: view.personName,
      }))
      membership = all.find(view => view.groupId === session.groupId) ?? all[0] ?? null
    } catch {
      // A database that has not been migrated yet must not stop the SPA from booting.
      membership = null
    }
  }

  const payload: MePayload = {
    authenticated: signedIn,
    username: account?.username ?? null,
    personId: membership?.personId ?? who?.ID ?? null,
    personName: membership?.personName ?? who?.name ?? null,
    userId: session?.userId ?? null,
    groupId: membership?.groupId ?? null,
    groupName: membership?.groupName ?? null,
    kind: membership?.kind ?? null,
    role: membership?.role ?? null,
    memberships,
  }
  res.setHeader('Cache-Control', 'no-store')
  res.json(payload)
}

interface MembershipSummary {
  groupId: string
  groupName: string
  role: string
  personName: string
}

interface RosterRow {
  ID: string
  name: string | null
  email: string | null
  isDefault: boolean | null
}

/**
 * The `People` row a login belongs to, matched the way `srv/ledger-service.ts` matches it.
 *
 * Same rule as `LedgerService`'s viewer (CONTRACTS.md §11.3): email first, then name, then
 * the first `isDefault` person, then whoever is first. The roster is sorted here rather than
 * in SQL so "the first `isDefault` person" means the same thing on every driver.
 *
 * **This never throws.** A bare express app in a test has no database at all, and
 * `/api/auth/me` still has to answer — the SPA routes on it.
 */
async function rosterEntry(login: string | null): Promise<{ ID: string; name: string } | null> {
  try {
    const rows = (await SELECT.from(People).columns(
      'ID',
      'name',
      'email',
      'isDefault',
    )) as unknown as RosterRow[]
    if (!Array.isArray(rows) || rows.length === 0) return null

    const roster = [...rows].sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '') || String(a.ID).localeCompare(String(b.ID)),
    )
    // Case-folded on both sides: humans and identity providers are inconsistent about the
    // case of a local part, and `Anna@` failing to match `anna@` is a dull bug to chase.
    const claimed = (login ?? '').trim().toLowerCase()
    const matched =
      claimed === ''
        ? undefined
        : (roster.find(row => (row.email ?? '').toLowerCase() === claimed) ??
          roster.find(row => (row.name ?? '').toLowerCase() === claimed))

    const chosen = matched ?? roster.find(row => row.isDefault === true) ?? roster[0]
    return { ID: String(chosen.ID), name: chosen.name ?? '' }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 *  8. The SPA
 * ------------------------------------------------------------------ */

/**
 * Serve `app/dist` at `/`, with a history fallback, without swallowing the API.
 *
 * Two things make this more than one `express.static` call.
 *
 * First, the fallback is registered at bootstrap, *before* `/ledger` and `/admin` exist,
 * so it has to know not to answer for them — hence `API_PREFIXES`.
 *
 * Second, CAP's own default is `express.static(cds.env.folders.app)`, i.e. the `app/`
 * **source** folder, which in production would cheerfully serve `app/vite.config.ts` and
 * `app/package.json`. Sending a 404 for an unmatched path that looks like a file, instead
 * of calling `next()`, is what stops a request ever reaching that default.
 */
function mountSpa(app: express.Application): void {
  if (!existsSync(DIST_INDEX)) {
    LOG.info('app/dist not built — the SPA is served by Vite in dev (npm run dev)')
    // There is nothing to serve, but in production the fallthrough still has to be closed.
    // The next handler down is CAP's `express.static(cds.env.folders.app)` over the app
    // **source** folder, which answers `/package.json`, `/vite.config.ts`, `/src/main.tsx`
    // and every file under `app/node_modules` with a 200. A web build that did not run has
    // to degrade to "no SPA", never to "the source tree is downloadable". Left open in
    // development, where that same default is how `cds watch` serves its own index page.
    if (isProduction()) app.use(spaFallback(null))
    return
  }

  app.use(
    express.static(DIST_DIR, {
      index: false,
      // `index.html` and the service worker are the two files that must never be served
      // from a stale cache, or a deploy takes a week to reach an installed PWA.
      setHeaders(res, filePath) {
        res.setHeader(
          'Cache-Control',
          IMMUTABLE_ASSET.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
        )
      },
    }),
  )

  app.use(spaFallback(DIST_INDEX))

  LOG.info('serving the SPA from app/dist')
}

/**
 * The last word on any GET that got this far: the SPA shell, or a 404.
 *
 * What matters as much as what it answers is what it never does — call `next()` for a
 * non-API GET. The handler behind it is CAP's `express.static` over the app *source*
 * folder, so falling through is how a deployment starts serving its own repository.
 *
 * `index` is null when there is no build to fall back on, and then everything outside the
 * API is a 404.
 */
function spaFallback(index: string | null): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (isApiPath(req.path)) return next()
    if (index === null || extname(req.path) !== '') {
      res.status(404).type('text/plain').send('Not found')
      return
    }
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(index)
  }
}

function isApiPath(path: string): boolean {
  return API_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

/* ------------------------------------------------------------------ *
 *  9. Errors raised by the middleware above
 * ------------------------------------------------------------------ */

/**
 * Turn a failure in one of the middlewares registered above into clean JSON.
 *
 * Express matches error handlers by registration order, so this one sees exactly the
 * layers in this file and nothing from the service routers CAP mounts afterwards — those
 * keep CAP's own error middleware, which knows how to shape an OData error. The point of
 * this handler is that express's built-in one prints a stack trace into the response body
 * outside production.
 */
function bootstrapErrors(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(error)

  const status = statusOf(error)
  if (status >= 500) LOG.error('request failed before reaching a service:', message(error))
  res.status(status).json({
    error: {
      code:
        status === 413 ? 'payload_too_large' : status === 401 ? 'unauthenticated' : 'bad_request',
      message: status >= 500 ? 'internal error' : message(error),
    },
  })
}

function statusOf(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 500
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown }
  for (const candidate of [status, statusCode]) {
    if (typeof candidate === 'number' && candidate >= 400 && candidate <= 599) return candidate
  }
  return 500
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/* ------------------------------------------------------------------ *
 *  10. Wiring
 * ------------------------------------------------------------------ *
 *
 * Last in the file, not first, and that placement is load-bearing: `loadCredentials()`
 * runs the moment this module is required, and it reads module-level `const`s declared
 * above. Function declarations hoist; `const` does not, so calling it from the top of the
 * file throws `Cannot access 'BCRYPT_HASH' before initialization` — in production only,
 * where it is least welcome. Everything below runs after every declaration is initialised.
 *
 * All of it still happens before `cds.emit('bootstrap', app)`, because CAP requires this
 * module to completion first.
 */

// CAP's own CORS shim echoes *whatever* Origin it is given, which is the opposite of
// "locked to same origin". It is off in production already; turning it off everywhere
// means `sameOriginCors` is the only thing writing those headers.
cds.env.server.cors = false

// The body-parser limit CAP hands to `express.text()` for every protocol adapter. The
// per-path guard above is the cheap first line; this is the one that holds for a chunked
// request with no Content-Length, because raw-body counts bytes as they arrive.
cds.env.server.body_parser = { ...cds.env.server.body_parser, limit: MAX_UPLOAD_REQUEST_BYTES }

const credentials = isProduction() ? loadCredentials() : optionalCredentials()
if (isProduction() && credentials !== null) {
  installProductionAuth(credentials)
  if (!sessionSecretConfigured()) {
    // Not fatal — the fallback key is random, so it is stronger than a configured one,
    // it simply does not outlive the process or reach a second instance. Basic auth,
    // which is what every existing deployment uses, is unaffected either way.
    LOG.warn(
      'SESSION_SECRET is not set: cookie sessions are signed with a key chosen at boot, ' +
        'so everyone signs in again after a restart and a session only works on the ' +
        'instance that issued it',
    )
  }
}

/**
 * Bring the database up to the current model before a single request is served.
 *
 * `cds deploy` creates a database from scratch and is right for development; the volume
 * in production holds real data and must be altered in place instead. Shipping phase 0
 * without this took the live API down with `no such column: group_ID` -- the image knew
 * about a column the volume had never been told about. `migrate()` is additive and
 * idempotent, so this costs a boot nothing once it has run.
 *
 * `served` rather than `bootstrap`: the database is connected by then. A failure here is
 * fatal on purpose -- serving requests against a database of the wrong shape is worse
 * than not starting.
 */
cds.on('served', async () => {
  const database = cds.db as unknown as { run(query: string): Promise<unknown> } | undefined
  if (database === undefined) return
  await migrate(database)
  // After the tables are right, make the views describe them. A projection is a SQL
  // view whose columns are fixed at creation, so altering a table underneath one leaves
  // it describing the old shape -- which is what kept the API answering 500 even once
  // `group_ID` existed.
  await refreshViews(database)
})

/**
 * Point CAP at Postgres when `DATABASE_URL` is set, before anything connects.
 *
 * At module load rather than on `bootstrap`: by the time an event fires, CAP may already
 * have resolved `cds.requires.db`, and a database chosen twice is a database chosen wrong.
 * With no `DATABASE_URL` this does nothing at all and the SQLite file stays the store, which
 * is what development, the tests and a single household all still want (`lib/database.ts`).
 */
const store = configureDatabase()
if (store === 'postgres') cds.log('server').info('database: postgres')

/**
 * Hang the points awards off the acts that earn them.
 *
 * `served` because it reaches across services and every one of them has to exist first, and
 * `after` handlers because a failed act must earn nothing. The services are looked up by
 * name and each is optional: a deployment that has not enabled the commons still boots, and
 * still awards points for everything else.
 *
 * Points are minted here and nowhere a client can reach — see `srv/wallet-service.ts`. An
 * endpoint that took "award me for X" would be an infinite points endpoint about ten minutes
 * after somebody opened the network tab.
 */
cds.on('served', (services: Record<string, unknown>) => {
  attachAwards({
    commons: services.CommonsService as Service | undefined,
    ledger: services.LedgerService as Service | undefined,
  })
})

cds.on('bootstrap', configureApp)
cds.on('served', verifyLoginMapping)
