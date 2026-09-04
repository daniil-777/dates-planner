/**
 * Vendors the basemap style into `public/basemap/style.json`.
 *
 * ## Why this is a build step and not a fetch
 *
 * The style is 43 kB of JSON that changes a few times a year, and it is the one file the map
 * cannot start without. Fetching it at runtime would mean the map has a cold-start round trip
 * before it draws anything, would leave it broken offline until somebody had opened it once
 * online, and would make the app's appearance depend on a file somebody else can change
 * without telling us. Vendored, it is precached with the rest of the shell, the map draws on
 * the first frame, and a restyle upstream is a diff in this repo rather than a surprise.
 *
 * ## What it rewrites, and why every one matters
 *
 * OpenFreeMap's style points at `tiles.openfreemap.org` in four places — glyphs, sprite, the
 * vector source and the shaded-relief raster. All four are rewritten to `/api/basemap/…`, the
 * same-origin proxy in `srv/lib/commons/basemap.ts`. Miss one and it fails *silently*: the
 * CSP refuses the cross-origin fetch, MapLibre logs nothing useful, and the map renders
 * without labels or without land, which reads as a styling bug rather than a blocked request.
 *
 * Run it with `npm run basemap:style` after an upstream restyle. The output is committed.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM = 'https://tiles.openfreemap.org'
const MOUNT = '/api/basemap'
const STYLE = process.argv[2] ?? 'liberty'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'public', 'basemap', 'style.json')

const rewrite = value =>
  typeof value === 'string' && value.startsWith(UPSTREAM) ? MOUNT + value.slice(UPSTREAM.length) : value

const response = await fetch(`${UPSTREAM}/styles/${STYLE}`, {
  headers: { 'user-agent': 'TwoWayMatch/1.0 (basemap vendoring)' },
})
if (!response.ok) throw new Error(`${STYLE}: HTTP ${response.status}`)
const style = await response.json()

style.glyphs = rewrite(style.glyphs)
style.sprite = rewrite(style.sprite)
for (const source of Object.values(style.sources ?? {})) {
  if (typeof source.url === 'string') source.url = rewrite(source.url)
  if (Array.isArray(source.tiles)) source.tiles = source.tiles.map(rewrite)
}

// A style that still names the tile host somewhere is a style with a request that will be
// blocked at runtime. Fail the build rather than ship it.
const leftovers = JSON.stringify(style).split(UPSTREAM).length - 1
if (leftovers > 0) throw new Error(`${leftovers} reference(s) to ${UPSTREAM} survived the rewrite`)

writeFileSync(OUT, JSON.stringify(style))
console.log(
  `wrote ${OUT} — ${style.layers.length} layers, ${Object.keys(style.sources).length} sources, ` +
    `${(JSON.stringify(style).length / 1024).toFixed(1)} kB`,
)
