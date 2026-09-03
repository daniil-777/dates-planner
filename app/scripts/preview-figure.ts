/**
 * Renders the mannequin to PNG contact sheets, with no browser and no WebGL.
 *
 * The figure is geometry, and geometry is arithmetic — so the one thing that actually
 * decides whether this feature is any good, *what it looks like*, should not require a
 * phone in your hand to check. This walks the merged mesh with a z-buffer and a matte
 * three-light shade, exactly the lighting `BodyCanvas` sets up, and writes a turntable
 * per form.
 *
 *   npx tsx app/scripts/preview-figure.ts                 # all three forms, four angles
 *   npx tsx app/scripts/preview-figure.ts --form feminine --zones
 *
 * `--zones` paints each region its own hue instead of shading the body, which is how you
 * check that a boundary falls where a human would put it rather than where the predicate
 * happened to land.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
import { Color } from 'three'

import { buildFigure, FIGURE_HEIGHT } from '../src/pages/intimacy/figure'
import { FORMS, ZONE_CODES, type BodyForm } from '../src/pages/intimacy/zones'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../../.preview')

/** Rendered at this size, then box-filtered down — cheap, effective antialiasing. */
const SUPERSAMPLE = 3
const VIEW_W = 460
const VIEW_H = 950
const ANGLES: ReadonlyArray<{ name: string; azimuth: number }> = [
  { name: 'front', azimuth: 0 },
  { name: 'three-quarter', azimuth: Math.PI / 4 },
  { name: 'side', azimuth: Math.PI / 2 },
  { name: 'back', azimuth: Math.PI },
]

interface Vec3 {
  x: number
  y: number
  z: number
}

function rotateY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }
}

function normalise(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** The same three lights `BodyCanvas` uses, in view space. */
const KEY = normalise({ x: 0.52, y: 0.72, z: 0.68 })
const RIM = normalise({ x: -0.62, y: 0.34, z: -0.6 })
const AMBIENT = 0.34

/** Matte, slightly warm, like unglazed plaster — the material a figure study wants. */
const SKIN: Vec3 = { x: 0.86, y: 0.76, z: 0.7 }
const RIM_TINT: Vec3 = { x: 0.62, y: 0.74, z: 0.95 }
const BACKGROUND = 22

function shade(n: Vec3, albedo: Vec3): Vec3 {
  const key = Math.max(0, dot(n, KEY))
  const rim = Math.pow(Math.max(0, dot(n, RIM)), 1.6)
  // Wrapped diffuse: a body is not a billiard ball, and letting the terminator wrap past
  // 90 degrees is the cheapest approximation of light bleeding through skin.
  const wrapped = Math.max(0, (dot(n, KEY) + 0.35) / 1.35)
  const lit = AMBIENT + 1.15 * (0.65 * key + 0.35 * wrapped)
  return {
    x: Math.min(1, albedo.x * lit + RIM_TINT.x * rim * 0.42),
    y: Math.min(1, albedo.y * lit + RIM_TINT.y * rim * 0.42),
    z: Math.min(1, albedo.z * lit + RIM_TINT.z * rim * 0.42),
  }
}

/** Distinct hues for the nineteen regions, for `--zones`. */
const ZONE_COLOURS: Vec3[] = ZONE_CODES.map((_code, index) => {
  const c = new Color().setHSL((index * 0.618033988749895) % 1, 0.62, 0.55)
  return { x: c.r, y: c.g, z: c.b }
})

interface RenderOptions {
  azimuth: number
  byZone: boolean
}

function renderView(form: BodyForm, options: RenderOptions): Uint8Array {
  const { geometry, zones } = buildFigure(form)
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const index = geometry.getIndex()

  const W = VIEW_W * SUPERSAMPLE
  const H = VIEW_H * SUPERSAMPLE
  const pixels = new Uint8Array(W * H * 3).fill(BACKGROUND)
  const depth = new Float32Array(W * H).fill(Infinity)

  // Frame the figure with a little air top and bottom; the camera is orthographic, which
  // for a standing figure is kinder than perspective — no foreshortened head.
  const scale = (H * 0.92) / FIGURE_HEIGHT
  const originX = W / 2
  const originY = H * 0.96

  const project = (v: Vec3): { sx: number; sy: number; z: number } => ({
    sx: originX + v.x * scale,
    sy: originY - v.y * scale,
    z: v.z,
  })

  const count = index === null ? position.count : index.count
  const vertexAt = (i: number): number => (index === null ? i : index.getX(i))

  for (let t = 0; t < count; t += 3) {
    const ia = vertexAt(t)
    const ib = vertexAt(t + 1)
    const ic = vertexAt(t + 2)

    const pa = rotateY({ x: position.getX(ia), y: position.getY(ia), z: position.getZ(ia) }, options.azimuth)
    const pb = rotateY({ x: position.getX(ib), y: position.getY(ib), z: position.getZ(ib) }, options.azimuth)
    const pc = rotateY({ x: position.getX(ic), y: position.getY(ic), z: position.getZ(ic) }, options.azimuth)

    const na = rotateY({ x: normal.getX(ia), y: normal.getY(ia), z: normal.getZ(ia) }, options.azimuth)
    const nb = rotateY({ x: normal.getX(ib), y: normal.getY(ib), z: normal.getZ(ib) }, options.azimuth)
    const nc = rotateY({ x: normal.getX(ic), y: normal.getY(ic), z: normal.getZ(ic) }, options.azimuth)

    const sa = project(pa)
    const sb = project(pb)
    const sc = project(pc)

    const area = (sb.sx - sa.sx) * (sc.sy - sa.sy) - (sc.sx - sa.sx) * (sb.sy - sa.sy)
    if (area === 0) continue

    const minX = Math.max(0, Math.floor(Math.min(sa.sx, sb.sx, sc.sx)))
    const maxX = Math.min(W - 1, Math.ceil(Math.max(sa.sx, sb.sx, sc.sx)))
    const minY = Math.max(0, Math.floor(Math.min(sa.sy, sb.sy, sc.sy)))
    const maxY = Math.min(H - 1, Math.ceil(Math.max(sa.sy, sb.sy, sc.sy)))
    if (minX > maxX || minY > maxY) continue

    const albedo = options.byZone ? (ZONE_COLOURS[zones[ia] ?? 0] ?? SKIN) : SKIN

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const cx = px + 0.5
        const cy = py + 0.5
        let w0 = ((sb.sx - sa.sx) * (cy - sa.sy) - (cx - sa.sx) * (sb.sy - sa.sy)) / area
        let w1 = ((cx - sa.sx) * (sc.sy - sa.sy) - (sc.sx - sa.sx) * (cy - sa.sy)) / area
        const w2 = 1 - w0 - w1
        // w0 weights c, w1 weights b, w2 weights a — the usual edge-function shuffle.
        if (w0 < 0 || w1 < 0 || w2 < 0) continue

        const z = w2 * sa.z + w1 * sb.z + w0 * sc.z
        const slot = py * W + px
        // Larger z is nearer: the camera looks down -Z after the rotation above.
        if (z <= -depth[slot]!) continue
        depth[slot] = -z

        const n = normalise({
          x: w2 * na.x + w1 * nb.x + w0 * nc.x,
          y: w2 * na.y + w1 * nb.y + w0 * nc.y,
          z: w2 * na.z + w1 * nb.z + w0 * nc.z,
        })
        const lit = shade(n, albedo)
        const o = slot * 3
        pixels[o] = Math.round(lit.x * 255)
        pixels[o + 1] = Math.round(lit.y * 255)
        pixels[o + 2] = Math.round(lit.z * 255)
        w0 = 0
        w1 = 0
      }
    }
  }

  return pixels
}

async function contactSheet(form: BodyForm, byZone: boolean): Promise<string> {
  const W = VIEW_W * SUPERSAMPLE
  const H = VIEW_H * SUPERSAMPLE

  const tiles = await Promise.all(
    ANGLES.map(async angle => {
      const raw = renderView(form, { azimuth: angle.azimuth, byZone })
      return sharp(Buffer.from(raw), { raw: { width: W, height: H, channels: 3 } })
        .resize(VIEW_W, VIEW_H, { kernel: 'lanczos3' })
        .png()
        .toBuffer()
    }),
  )

  mkdirSync(OUT_DIR, { recursive: true })
  const file = resolve(OUT_DIR, `${form}${byZone ? '-zones' : ''}.png`)
  await sharp({
    create: {
      width: VIEW_W * ANGLES.length,
      height: VIEW_H,
      channels: 3,
      background: { r: BACKGROUND, g: BACKGROUND, b: BACKGROUND },
    },
  })
    .composite(tiles.map((input, i) => ({ input, left: VIEW_W * i, top: 0 })))
    .png()
    .toFile(file)
  return file
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const byZone = argv.includes('--zones')
  const formArg = argv[argv.indexOf('--form') + 1]
  const forms: readonly BodyForm[] =
    argv.includes('--form') && FORMS.includes(formArg as BodyForm) ? [formArg as BodyForm] : FORMS

  for (const form of forms) {
    const started = process.hrtime.bigint()
    const { geometry } = buildFigure(form)
    const built = Number(process.hrtime.bigint() - started) / 1e6
    const index = geometry.getIndex()
    const triangles = (index === null ? geometry.getAttribute('position').count : index.count) / 3
    const file = await contactSheet(form, byZone)
    console.log(
      `${form.padEnd(10)} ${geometry.getAttribute('position').count
        .toString()
        .padStart(7)} verts  ${triangles.toString().padStart(7)} tris  ${built.toFixed(0).padStart(4)} ms  → ${file}`,
    )
  }
}

await main()
