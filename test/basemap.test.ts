/**
 * The basemap proxy.
 *
 * Two of these guard mistakes that were actually made while writing it, and both had the same
 * character: the map rendered *something*, so nothing looked broken, and the fault was only
 * visible if you knew what to compare against.
 */
import { describe, expect, it } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'

import { basemapProxy, isAllowedPath, rewriteTileJson } from '../srv/lib/commons/basemap'

const MOUNT = '/api/basemap'

/**
 * Mounts the proxy on a real ephemeral socket and asks it one question.
 *
 * A real server rather than a request-shaped object, matching `security.test.ts`: the two
 * things most worth checking here are response *headers*, and those are exactly what a
 * pretend request/response pair is most likely to get subtly wrong.
 */
async function ask(
  fetchImpl: typeof fetch,
  path: string,
  method = 'GET',
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const app = express()
  app.use(MOUNT, basemapProxy({ mountedAt: MOUNT, fetchImpl }))
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method })
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

/** A stand-in upstream, so no test in this file touches the network. */
function upstream(
  body: Buffer | object,
  headers: Record<string, string> = {},
  status = 200,
): typeof fetch {
  return (async () =>
    new Response(body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/octet-stream', ...headers },
    })) as unknown as typeof fetch
}

describe('what it will forward', () => {
  it('accepts the five shapes the style actually asks for', () => {
    for (const path of [
      '/planet',
      '/planet/20260830_080001_pt/14/8546/5741.pbf',
      '/fonts/Noto Sans Regular/0-255.pbf',
      '/sprites/ofm_f384/ofm.json',
      '/sprites/ofm_f384/ofm@2x.png',
      '/natural_earth/ne2sr/4/8/5.png',
    ]) {
      expect(isAllowedPath(path), path).toBe(true)
    }
  })

  it('refuses everything else', () => {
    for (const path of [
      '/etc/passwd',
      '/planet/../../secret',
      '/planet/x/../../../etc/passwd',
      '/styles/liberty',
      '/',
      '/fonts/../../x.pbf',
      '\\windows\\system32',
    ]) {
      expect(isAllowedPath(path), path).toBe(false)
    }
  })

  it('answers 404 rather than forwarding an unknown path', async () => {
    // A proxy that forwards whatever it is handed is a habit worth not having, even when the
    // thing behind it is only a CDN.
    let called = false
    const spy = (async () => {
      called = true
      return new Response('')
    }) as unknown as typeof fetch

    expect((await ask(spy, `${MOUNT}/etc/passwd`)).status).toBe(404)
    expect(called).toBe(false)
  })

  it('refuses a method that is not a read', async () => {
    const sent = await ask(upstream(Buffer.from([1])), `${MOUNT}/planet`, 'POST')
    expect(sent.status).toBe(405)
  })
})

describe('the TileJSON', () => {
  it('is rewritten to point back at us, or the tiles go cross-origin again', () => {
    // The one response that cannot be passed through untouched. MapLibre requests exactly
    // what it finds in `tiles`, so leaving it alone sends every tile request to the tile host
    // — the thing the proxy exists to prevent — and the CSP then blocks it *silently*.
    const rewritten = rewriteTileJson(
      {
        tilejson: '3.0.0',
        tiles: ['https://tiles.openfreemap.org/planet/20260830_080001_pt/{z}/{x}/{y}.pbf'],
        vector_layers: [{ id: 'poi' }],
      },
      MOUNT,
    ) as { tiles: string[]; vector_layers: unknown[] }

    expect(rewritten.tiles).toEqual(['/api/basemap/planet/20260830_080001_pt/{z}/{x}/{y}.pbf'])
    // Everything else survives: `vector_layers` is what tells MapLibre the `poi` layer exists,
    // and without it the restaurants this feature is built on are invisible.
    expect(rewritten.vector_layers).toHaveLength(1)
  })

  it('leaves a url it does not recognise alone', () => {
    const same = rewriteTileJson({ tiles: ['/already/local/{z}.pbf'] }, MOUNT) as {
      tiles: string[]
    }
    expect(same.tiles).toEqual(['/already/local/{z}.pbf'])
  })

  it('survives a body that is not TileJSON at all', () => {
    expect(rewriteTileJson(null, MOUNT)).toBeNull()
    expect(rewriteTileJson({ no: 'tiles' }, MOUNT)).toEqual({ no: 'tiles' })
  })
})

describe('the header that would have corrupted every tile', () => {
  it('never forwards content-encoding, because the body is already decompressed', async () => {
    /*
     * Node's fetch gunzips the body itself but leaves `content-encoding: gzip` on the
     * response. Measured against a real tile: the header said gzip, `content-length` said
     * 43,356, and there were 61,355 plain bytes in hand.
     *
     * Forwarding either header tells the browser to gunzip bytes that are already plain, and
     * MapLibre fails to parse every tile — with a map that still renders its background, its
     * attribution and its controls, so it reads as an empty tile source rather than as a
     * mangled one.
     */
    const plain = Buffer.from([0x1a, 0x8c, 0x2f, 0x0a])
    const response = await ask(
      upstream(plain, {
        'content-type': 'application/vnd.mapbox-vector-tile',
        'content-encoding': 'gzip',
        'content-length': '43356',
      }),
      `${MOUNT}/planet/20260830_080001_pt/14/8546/5741.pbf`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-type')).toContain('mapbox-vector-tile')
    // Express sets a length for what was actually sent, not what upstream claimed.
    expect(response.headers.get('content-length')).toBe(String(plain.length))
    expect(response.body).toEqual(plain)
  })
})

describe('caching and failure', () => {
  it('lets a tile be cached for a week and the index for an hour', async () => {
    const tile = await ask(upstream(Buffer.from([1])), `${MOUNT}/natural_earth/ne2sr/4/8/5.png`)
    expect(tile.status).toBe(200)
    expect(tile.headers.get('cache-control')).toContain('max-age=604800')

    // The index names the current planet build, so caching it for a week would pin the map to
    // a build that has been deleted upstream.
    const index = await ask(upstream({ tiles: [] }), `${MOUNT}/planet`)
    expect(index.status).toBe(200)
    expect(index.headers.get('cache-control')).toContain('max-age=3600')
  })

  it('turns an upstream failure into a 502, not a 500', async () => {
    // This server is fine and somebody else's is not, and MapLibre retries a 502 on the next
    // pan. A 500 would say the fault was ours.
    const broken = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    expect((await ask(broken, `${MOUNT}/planet`)).status).toBe(502)
  })

  it('passes a 404 through as a 404', async () => {
    const missing = await ask(upstream(Buffer.from([]), {}, 404), `${MOUNT}/planet/x/1/1/1.pbf`)
    expect(missing.status).toBe(404)
  })
})
