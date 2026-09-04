/**
 * The basemap, served from this origin.
 *
 * ## Why the tiles come through here rather than from the tile host
 *
 * Three reasons, and each one is load-bearing on its own.
 *
 * **The CSP.** `connect-src` is `'self'` in production (srv/server.ts). Raster tiles are
 * `<img>` elements and fall under `img-src https:`, which is why the old Leaflet map worked;
 * vector tiles are `fetch()` calls and are refused outright. Proxying makes every request
 * same-origin, so the strongest form of the directive survives a modern map — that is the
 * rule the CSP comment already states: a third party gets proxied rather than allow-listed.
 *
 * **Offline.** The same directive governs `fetch()` *inside the service worker*, so Workbox
 * cannot cache a cross-origin tile here at all — measured, not assumed. Today the Places map
 * offline is a grey rectangle. Same-origin tiles can be cached, and the map somebody opened
 * on the way to a restaurant still draws when they get to the basement it is in.
 *
 * **The promise.** `PlacesMap` used to say "nothing about where a household goes leaves this
 * app" while the browser fetched tiles straight from `tile.openstreetmap.org` — which handed
 * a third party the household's IP address alongside the exact tile coordinates of their
 * street, on every pan. That was not true. It is true now: the tile host sees this server.
 *
 * ## Why OpenFreeMap
 *
 * It is the only good-looking basemap that permits this. Checked against each provider's own
 * terms: CARTO, Stadia and Thunderforest all forbid proxying and all now require a key —
 * CARTO stamps "API KEY REQUIRED" across a keyless tile. OpenFreeMap's terms are the
 * opposite of restrictive: "completely free: there are no limits on the number of map views
 * or requests. There's no registration, no user database, no API keys, and no cookies", and
 * self-hosting the whole stack is explicitly offered. It runs on donations, and this app
 * should be a donor rather than merely a user — see DEPLOY.md.
 *
 * ## What this is not
 *
 * Not an open proxy. It sits behind the same auth guard as everything else, and it forwards
 * only paths matching {@link ROUTES} — five exact shapes, no traversal, no query string, no
 * arbitrary host. An SSRF here would be an SSRF into a CDN, which is dull, but a proxy that
 * forwards whatever it is handed is a habit worth not having.
 */

import type { RequestHandler } from 'express'

const UPSTREAM = 'https://tiles.openfreemap.org'

/** Long enough to matter, short enough that a planet rebuild reaches people within a week. */
const TILE_MAX_AGE_S = 7 * 24 * 60 * 60

/** The TileJSON names the current planet build, so it must not be cached for a week. */
const INDEX_MAX_AGE_S = 60 * 60

const FETCH_TIMEOUT_MS = 15_000

/**
 * Every path this will forward, and nothing else.
 *
 * Written as anchored patterns over the *whole* path rather than a prefix check, because a
 * prefix check plus `..` is the oldest hole there is. Express has already normalised the URL
 * by the time this runs, and this refuses anything with a `.` segment regardless.
 */
const ROUTES: readonly RegExp[] = [
  // The TileJSON. Rewritten on the way back — see below.
  /^\/planet$/,
  // The vector tiles themselves: /planet/<build>/{z}/{x}/{y}.pbf
  /^\/planet\/[\w-]{1,40}\/\d{1,2}\/\d{1,7}\/\d{1,7}\.pbf$/,
  // Glyphs: /fonts/<fontstack>/<range>.pbf — the fontstack is human text with spaces.
  /^\/fonts\/[\w %,.-]{1,120}\/\d{1,5}-\d{1,5}\.pbf$/,
  // Sprites: /sprites/<set>/<name>.json|.png, optionally @2x.
  /^\/sprites\/[\w-]{1,40}\/[\w-]{1,40}(@\d(\.\d)?x)?\.(json|png)$/,
  // The shaded relief underlay: /natural_earth/<set>/{z}/{x}/{y}.png
  /^\/natural_earth\/[\w-]{1,40}\/\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/,
]

export function isAllowedPath(path: string): boolean {
  if (path.includes('..') || path.includes('\\')) return false
  return ROUTES.some(route => route.test(path))
}

/**
 * OpenFreeMap asks for nothing, but a proxy that does not name itself is a proxy nobody can
 * contact when it misbehaves. The same string the Nominatim client sends.
 */
function userAgent(env: NodeJS.ProcessEnv = process.env): string {
  const contact = env.COMMONS_CONTACT?.trim()
  return `TwoWayMatch/1.0 (${contact !== undefined && contact.length > 0 ? contact : 'https://github.com/daniil-777/dates-planner'})`
}

/**
 * The TileJSON points at the tile host; it has to point back here instead.
 *
 * This is the one response that cannot be passed through untouched. MapLibre reads `tiles`
 * from it and requests exactly what it finds there — leave it alone and every tile request
 * goes cross-origin again, which is the thing this file exists to prevent, and it would fail
 * silently under the CSP rather than loudly.
 */
export function rewriteTileJson(body: unknown, mountedAt: string): unknown {
  if (typeof body !== 'object' || body === null) return body
  const json = body as Record<string, unknown>
  const tiles = json.tiles
  if (!Array.isArray(tiles)) return json
  return {
    ...json,
    tiles: tiles.map(url =>
      typeof url === 'string' && url.startsWith(UPSTREAM)
        ? `${mountedAt}${url.slice(UPSTREAM.length)}`
        : url,
    ),
  }
}

export interface BasemapOptions {
  /** Where this handler is mounted, for rewriting the TileJSON. */
  mountedAt: string
  /** Injected by the tests. */
  fetchImpl?: typeof fetch
}

/**
 * Forwards one basemap asset.
 *
 * Failures are plain status codes rather than the app's error envelope: the caller is
 * MapLibre, which wants a number, and a JSON error body would be decoded as a tile.
 */
export function basemapProxy(options: BasemapOptions): RequestHandler {
  const call = options.fetchImpl ?? fetch

  return (request, response) => {
    void (async () => {
      // Express strips the mount path, so `path` here is the upstream path. A missing
      // leading slash would silently become a relative URL against the upstream origin.
      const path = request.path.startsWith('/') ? request.path : `/${request.path}`

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.status(405).end()
        return
      }
      if (!isAllowedPath(path)) {
        response.status(404).end()
        return
      }

      try {
        const upstream = await call(`${UPSTREAM}${path}`, {
          headers: { 'user-agent': userAgent(), accept: '*/*' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })

        if (!upstream.ok) {
          response.status(upstream.status === 404 ? 404 : 502).end()
          return
        }

        const isIndex = path === '/planet'
        response.setHeader(
          'Cache-Control',
          `public, max-age=${isIndex ? INDEX_MAX_AGE_S : TILE_MAX_AGE_S}`,
        )
        // Tiles are `.pbf` and are gzipped at rest upstream; the content type has to survive
        // or MapLibre refuses the body.
        const type = upstream.headers.get('content-type')
        if (type !== null) response.setHeader('Content-Type', type)

        if (isIndex) {
          const body: unknown = await upstream.json()
          response.json(rewriteTileJson(body, options.mountedAt))
          return
        }

        // `content-encoding` and `content-length` are deliberately NOT forwarded.
        //
        // Node's fetch decompresses the body itself but leaves the header saying `gzip` —
        // measured on a real tile: `content-encoding: gzip`, `content-length: 43356`, and
        // 61,355 plain bytes in hand. Forwarding either would tell the browser to gunzip
        // bytes that are already plain, and every tile would fail to parse. Express sets a
        // correct `Content-Length` for what is actually sent.
        response.send(Buffer.from(await upstream.arrayBuffer()))
      } catch {
        // Timeout, DNS, or a socket closing. 502 rather than 500: this server is fine and
        // somebody else's is not, and MapLibre retries a 502 on the next pan.
        if (!response.headersSent) response.status(502).end()
      }
    })()
  }
}
