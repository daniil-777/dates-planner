/**
 * Bakes the mannequin from MakeHuman's CC0 base mesh.
 *
 *   npx tsx app/scripts/bake-figure.ts            # fetch if needed, bake, write the asset
 *   npx tsx app/scripts/bake-figure.ts --report   # measurements only, write nothing
 *
 * ## Why a baked sculpt and not a procedural body
 *
 * The figure used to be built on the phone from a signed distance field of blended
 * ellipsoids. That gives a smooth, join-free surface and a head like a thumb: a field of
 * soft masses can produce a deltoid, and it cannot produce an ear, a nostril, five fingers
 * or a heel. Anatomy that fine is not a modelling problem to be solved with more masses —
 * it is a sculpt, and a good one already exists in the public domain.
 *
 * MakeHuman's `hm08` base mesh was released as CC0 in September 2020 by Data Collection AB,
 * Joel Palmius and Jonas Hauquier. The licence is stated in the header of every file this
 * script downloads and again in `NOTICE.md` beside it. The mesh is 13 380 vertices of
 * quads, watertight, two-manifold, symmetric, and standing in a relaxed A-pose — which is
 * the pose this feature wants, because arms held clear of the hips mean a thigh and a
 * forearm are never the same pixel under a thumb.
 *
 * ## The three forms are MakeHuman's own macro targets
 *
 * A target is a list of `index dx dy dz` deltas over the base mesh. `feminine` is the mean
 * of the three female young targets, `masculine` the mean of the three male. Each form is
 * therefore an average across MakeHuman's ethnicity axis rather than one point on it, which
 * is what its sliders do at their default third each — and the right choice here, because
 * the figure stands in for whoever is looking at it and picking one ethnicity to model
 * would be picking wrong for most people.
 *
 * `neutral` is the midpoint of the other two, which is why the asset does not store it:
 * neutral = base + ⅙Σ(all six) = ½(feminine + masculine), exactly. Deriving it at load
 * costs one add and a shift per coordinate and takes a third off the file.
 *
 * ## Regions come from the rig where the rig knows, and from anthropometry where it does not
 *
 * `default_weights.mhw` (CC0, same release) says which bone owns each vertex, and a bone is
 * a piece of anatomy — so `arms`, `hands`, `calves`, `feet`, `neck` and `lips` are read
 * straight off the dominant bone with no geometry involved at all.
 *
 * The rig cannot answer the rest, and it is worth being precise about why rather than
 * bending it into shape. A skeleton for animation has bones where the body *bends*; the
 * regions this app names are where the body is *touched*, and those are different
 * partitions. There is no shoulder bone in the colloquial sense — `clavicle` and
 * `shoulder01` between them own thirty vertices, and the shoulder a hand lands on belongs
 * to `upperarm01` and `spine01`. There is no buttock bone: the behind is the back of
 * `upperleg01`. Chest, stomach, upper and lower back are one continuous spine chain.
 *
 * So those splits are made against a stature-relative skeleton of heights — the standard
 * proportions, listed in `LANDMARKS` — always as a division of a single bone's territory,
 * never as a plane sliced through the whole body. The bone decides which page of the atlas
 * we are on; the landmark decides where on that page the line falls.
 *
 * Labels are then smoothed and despeckled here, once, rather than on a phone every time
 * somebody opens the page.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { ZONE_CODES, type ZoneCode } from '../src/pages/intimacy/zones'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, '.mh-cache')
const OUT = resolve(HERE, '../src/pages/intimacy/figureData.ts')

/** Height of the figure in metres. It is scaled to this and stands with its feet at y = 0. */
const FIGURE_HEIGHT = 1.8

/** The two stored forms, in the order the asset holds them. `neutral` is their midpoint. */
const STORED = ['feminine', 'masculine'] as const
type StoredForm = (typeof STORED)[number]

/* ----------------------------------------------------------------- sources */

const RAW = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master'

interface Source {
  readonly file: string
  readonly path: string
  readonly sha256: string
}

/**
 * Hashes are checked on every run. A build input that can change underneath you is a build
 * that is not reproducible, so upstream moving is a hard failure here rather than a quiet
 * re-bake with a different body in it.
 */
const SOURCES: readonly Source[] = [
  {
    file: 'base.obj',
    path: 'makehuman/data/3dobjs/base.obj',
    sha256: '8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c',
  },
  {
    file: 'weights.mhw',
    path: 'makehuman/data/rigs/default_weights.mhw',
    sha256: '0f3641d651ae3d00ad6b4ccee43142edb109d3bd909d27d9e4139ef1beed8625',
  },
  {
    file: 'l-ear-scale-incr.target',
    path: 'makehuman/data/targets/ears/l-ear-scale-incr.target',
    sha256: '8112e638fb6ecc46569c527494f5b20acd0c5544d891dbf09c7876402eac384c',
  },
  {
    file: 'r-ear-scale-incr.target',
    path: 'makehuman/data/targets/ears/r-ear-scale-incr.target',
    sha256: '4fa34a2a4d7254fdb5ac514b85b755b8ed0d73ed21450778b2dcb64275a3619d',
  },
  {
    file: 'african-female-young.target',
    path: 'makehuman/data/targets/macrodetails/african-female-young.target',
    sha256: '92d61eeb3c164b421fd5a7c3537ee45e7e1a51de4d49bf312e19c3df2be1d8fc',
  },
  {
    file: 'asian-female-young.target',
    path: 'makehuman/data/targets/macrodetails/asian-female-young.target',
    sha256: '095fe79694fa19e1fe98d93009ec116199bd524e081c640351a10eccf2cca1eb',
  },
  {
    file: 'caucasian-female-young.target',
    path: 'makehuman/data/targets/macrodetails/caucasian-female-young.target',
    sha256: '118379f6e8ba9266247fdb8788a20e1df40a239f97ced0b9905bcbcc74f6e820',
  },
  {
    file: 'african-male-young.target',
    path: 'makehuman/data/targets/macrodetails/african-male-young.target',
    sha256: '894abc1fbb3d28543a51fef16f89d5d4bdf9aa2e1534413339811a3d47818b7d',
  },
  {
    file: 'asian-male-young.target',
    path: 'makehuman/data/targets/macrodetails/asian-male-young.target',
    sha256: 'ed2e8c191cb6b87b4a2d97c80486acb2604fa549316c7aa2a738a5d5a14334dc',
  },
  {
    file: 'caucasian-male-young.target',
    path: 'makehuman/data/targets/macrodetails/caucasian-male-young.target',
    sha256: '70e228ba7164737dae664454394536fc5935fa48d333c1a97d77e2dc6eacc5f5',
  },
]

/**
 * The ear morphs, used as a definition rather than as a morph.
 *
 * A target lists the vertices it moves, so a target that scales an ear is a list of exactly
 * the vertices that are that ear — MakeHuman's authors' own answer to a question no
 * measurement of this mesh answers well. Both sides are needed: the targets are one-sided
 * and the mesh, though symmetric, is not indexed symmetrically.
 */
const EAR_TARGETS = ['l-ear-scale-incr', 'r-ear-scale-incr'] as const

const TARGETS_OF: Record<StoredForm, readonly string[]> = {
  feminine: ['african-female-young', 'asian-female-young', 'caucasian-female-young'],
  masculine: ['african-male-young', 'asian-male-young', 'caucasian-male-young'],
}

async function ensureSources(): Promise<void> {
  mkdirSync(CACHE, { recursive: true })
  for (const source of SOURCES) {
    const path = join(CACHE, source.file)
    if (!existsSync(path)) {
      process.stdout.write(`fetching ${source.file} … `)
      const response = await fetch(`${RAW}/${source.path}`)
      if (!response.ok) throw new Error(`${source.path} → ${response.status}`)
      writeFileSync(path, Buffer.from(await response.arrayBuffer()))
      process.stdout.write('ok\n')
    }
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (digest !== source.sha256) {
      throw new Error(
        `${source.file} does not match its pinned hash.\n` +
          `  expected ${source.sha256}\n  got      ${digest}\n` +
          'Upstream changed, or the cache is corrupt. Delete app/scripts/.mh-cache and re-run.',
      )
    }
  }
}

/* ------------------------------------------------------------------ parsing */

interface BaseMesh {
  /** Every vertex in the file, the helper and joint geometry included. */
  readonly positions: Float64Array
  /** Quads of the `body` group — the visible skin, and nothing else. */
  readonly quads: Uint32Array
  /** How many leading vertices the body group uses; the helpers follow them. */
  readonly bodyVertexCount: number
  /** Centroid of each `joint-*` cube, which is where MakeHuman puts that joint. */
  readonly joints: ReadonlyMap<string, readonly [number, number, number]>
}

function parseObj(text: string): BaseMesh {
  const positions: number[] = []
  const quads: number[] = []
  const jointVertices = new Map<string, Set<number>>()
  let group = ''

  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/)
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]))
    } else if (line.startsWith('g ')) {
      group = line.slice(2).trim()
    } else if (line.startsWith('f ')) {
      const corners = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map(token => Number.parseInt(token.split('/')[0]!, 10) - 1)
      if (group === 'body') {
        if (corners.length !== 4) throw new Error(`body face with ${corners.length} corners`)
        quads.push(...corners)
      } else if (group.startsWith('joint-')) {
        let set = jointVertices.get(group)
        if (set === undefined) jointVertices.set(group, (set = new Set()))
        for (const corner of corners) set.add(corner)
      }
    }
  }

  let bodyVertexCount = 0
  for (const index of quads) bodyVertexCount = Math.max(bodyVertexCount, index + 1)
  // The body group is the first block of vertices in the file, so the visible mesh is a
  // prefix of the vertex list and needs no remapping. Assert it rather than assume it.
  if (new Set(quads).size !== bodyVertexCount) {
    throw new Error('the body group is not a contiguous prefix of the vertex list')
  }

  const joints = new Map<string, readonly [number, number, number]>()
  for (const [name, set] of jointVertices) {
    let x = 0
    let y = 0
    let z = 0
    for (const index of set) {
      x += positions[index * 3]!
      y += positions[index * 3 + 1]!
      z += positions[index * 3 + 2]!
    }
    joints.set(name, [x / set.size, y / set.size, z / set.size])
  }

  return { positions: Float64Array.from(positions), quads: Uint32Array.from(quads), bodyVertexCount, joints }
}

/** `index dx dy dz` per line over the full vertex list, with `#` comments. */
function parseTarget(text: string, vertexCount: number): Float64Array {
  const delta = new Float64Array(vertexCount * 3)
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 4) continue
    const index = Number.parseInt(parts[0]!, 10)
    if (!Number.isFinite(index) || index >= vertexCount) continue
    delta[index * 3] = Number(parts[1])
    delta[index * 3 + 1] = Number(parts[2])
    delta[index * 3 + 2] = Number(parts[3])
  }
  return delta
}

/** The bone that owns each vertex — the one carrying the largest weight on it. */
function parseDominantBones(json: string, vertexCount: number): string[] {
  const parsed = JSON.parse(json) as { weights: Record<string, Array<[number, number]>> }
  const best = new Float64Array(vertexCount)
  const owner = new Array<string>(vertexCount).fill('')
  for (const [bone, pairs] of Object.entries(parsed.weights)) {
    for (const [index, weight] of pairs) {
      if (index < vertexCount && weight > best[index]!) {
        best[index] = weight
        owner[index] = bone
      }
    }
  }
  return owner
}

/* ------------------------------------------------------------------- zoning */

/**
 * The page of the atlas a vertex is on, read off its dominant bone.
 *
 * The facial rig collapses to two answers — the mouth bones are the mouth, everything else
 * on the head is the head — because this figure is tapped with a fingertip and a nostril is
 * not a destination. The `tongue*`, `eye*` and teeth bones drive helper geometry that is
 * not in the body group at all, so they never reach this function.
 */
type Region = 'head' | 'mouth' | 'neck' | 'arm' | 'hand' | 'trunk' | 'leg' | 'shin' | 'foot'

function regionOfBone(bone: string): Region | null {
  const stem = bone.replace(/\.[LR]$/, '')
  if (/^oris/.test(stem)) return 'mouth'
  if (stem === 'head' || stem === 'jaw') return 'head'
  if (/^(oculi|orbicularis|levator|risorius|special)/.test(stem)) return 'head'
  if (/^neck/.test(stem)) return 'neck'
  if (/^(upperarm|lowerarm)/.test(stem) || stem === 'clavicle' || stem === 'shoulder01') return 'arm'
  if (stem === 'wrist' || /^(metacarpal|finger)/.test(stem)) return 'hand'
  if (/^spine/.test(stem) || stem === 'breast' || stem === 'pelvis' || stem === 'root') return 'trunk'
  if (/^upperleg/.test(stem)) return 'leg'
  if (/^lowerleg/.test(stem)) return 'shin'
  if (stem === 'foot' || /^toe/.test(stem)) return 'foot'
  return null
}

/**
 * Heights as fractions of stature, from standard adult proportions.
 *
 * Written as fractions rather than metres so they stay true if the figure is ever scaled,
 * and checked against the mesh's own joints in `verifyLandmarks` — the rig and the textbook
 * should agree, and if they ever stop agreeing the build should say so rather than quietly
 * put a waistline through somebody's ribs.
 */
const LANDMARKS = {
  /** Top of the shoulder. Above this line an arm or a trapezius is the shoulder. */
  shoulder: 0.795,
  /** Bottom of the ribcage: chest above, stomach below, and the same line around the back. */
  ribs: 0.645,
  /** Iliac crest. Below this the trunk is hips and behind rather than stomach and back. */
  crest: 0.575,
  /** Centre of the hip joint. Only a cross-check: the femur head, not the crease. */
  hipJoint: 0.52,
  /** Where the legs part. Measured from the mesh; this is the value it is checked against. */
  crotch: 0.47,
  /** Down to here a thigh still has an inner face worth naming. */
  innerThighFloor: 0.34,
  /** The hairline. Above it, even at the front, is scalp rather than face. */
  hairline: 0.968,
} as const

interface Frame {
  /** Front-to-back middle of the trunk: in front of it is chest, behind it is back. */
  readonly trunkZ: number
  /** Front-to-back middle of the head. */
  readonly headZ: number
  /** The ears, as MakeHuman's own ear morphs define them. */
  readonly ears: ReadonlySet<number>
  /** Mean |x| of the leg at a given height — its axis, so a thigh can be halved down it. */
  readonly legAxis: (y: number) => number
  /** The bottom of the ear lobe. Below it the back of the head is jaw, not scalp. */
  readonly earFloor: number
  /** Half the width of the pelvis, which sets how far in `intimate` and `innerThighs` reach. */
  readonly pelvisHalfWidth: number
  /** Where the legs actually part on this mesh, measured rather than assumed. */
  readonly crotchY: number
}

const h = (fraction: number): number => fraction * FIGURE_HEIGHT

/**
 * Ear, scalp or face.
 *
 * Hair is the scalp: over the top above the hairline, and round the back down to the ear. Not
 * simply "behind the middle of the head" — that reads the underside of the jaw as scalp,
 * which is wrong, and splits the face in two on the way.
 */
function headZone(vertex: number, y: number, z: number, frame: Frame): ZoneCode {
  if (frame.ears.has(vertex)) return 'ears'
  const scalp = y > h(LANDMARKS.hairline) || (z < frame.headZ && y > frame.earFloor)
  return scalp ? 'hair' : 'face'
}

/**
 * The region of one vertex.
 *
 * Every branch is a split of a single bone's territory. Nothing here cuts across the body.
 */
function zoneOf(vertex: number, region: Region, x: number, y: number, z: number, frame: Frame): ZoneCode {
  const front = z > frame.trunkZ
  const side = Math.abs(x)

  switch (region) {
    case 'mouth':
      return 'lips'
    case 'hand':
      return 'hands'
    case 'shin':
      return 'calves'
    case 'foot':
      return 'feet'

    // The neck chain reaches up the back of the skull as far as the top of the ear, because
    // that is where the head *pivots* — not where a neck stops being a neck. Left uncut, it
    // walled the crown off from the occiput and left `hair` in four pieces.
    case 'neck':
      return y <= frame.earFloor ? 'neck' : headZone(vertex, y, z, frame)

    case 'head':
      return headZone(vertex, y, z, frame)

    case 'arm':
      // The cap over the joint reads as shoulder, not arm; below it the arm begins.
      return y > h(LANDMARKS.shoulder) ? 'shoulders' : 'arms'

    case 'trunk': {
      // The trapezius, out towards the joint, is the other half of the shoulder. Kept off
      // the midline so the base of the neck stays neck.
      if (y > h(LANDMARKS.shoulder) && side > frame.pelvisHalfWidth * 0.5) return 'shoulders'
      if (y > h(LANDMARKS.ribs)) return front ? 'chest' : 'upperBack'
      // Below the ribs the flanks are the hips — the word means the sides, and a hand put on
      // somebody's hip lands there rather than on their belly or the small of their back.
      if (side > frame.pelvisHalfWidth * 0.66) return 'hips'
      if (y > h(LANDMARKS.crest)) return front ? 'stomach' : 'lowerBack'
      if (!front) return 'glutes'
      // The lower belly runs down to the crease; only the small central patch under it has
      // its own name.
      return side < frame.pelvisHalfWidth * 0.42 && y < frame.crotchY + 0.06
        ? 'intimate'
        : 'stomach'
    }

    case 'leg': {
      // The behind is the back of the top of the thigh — there is no buttock bone.
      if (!front && y > frame.crotchY) return 'glutes'
      if (front && y > frame.crotchY && side < frame.pelvisHalfWidth * 0.42) return 'intimate'
      // Inner thigh is the half of the leg that faces the other leg, split down the leg's own
      // axis rather than at a fixed distance from the midline — the thigh moves outward as it
      // descends, and a fixed line would drift off it into the outer surface.
      return side < frame.legAxis(y) && y > h(LANDMARKS.innerThighFloor)
        ? 'innerThighs'
        : 'thighs'
    }
  }
}

/**
 * Measures the frame the rules above are stated in, and checks the textbook against the rig.
 *
 * Everything here is read off the mesh: nothing is a magic number that happens to work for
 * this sculpt and would silently stop working for another one.
 */
function makeFrame(
  positions: Float64Array,
  count: number,
  regions: readonly (Region | null)[],
  joints: BaseMesh['joints'],
  toMetres: (unit: readonly [number, number, number]) => [number, number, number],
  ears: ReadonlySet<number>,
): Frame {
  let trunkZ = 0
  let trunkN = 0
  let headZ = 0
  let headN = 0
  let pelvisHalfWidth = 0
  // |x| of leg vertices, summed into 2 cm bands of height, to give the leg's own axis.
  const LEG_BAND = 0.02
  const legSum = new Map<number, { sum: number; n: number }>()
  // The crotch is the lowest point of the body's midline: follow the seam between the legs
  // down and it stops where they part. Nothing anthropometric about it — it is where this
  // sculpt's legs meet, and the constant below only checks that answer for sanity.
  let crotchY = Infinity

  for (let v = 0; v < count; v += 1) {
    const region = regions[v]
    const x = positions[v * 3]!
    const y = positions[v * 3 + 1]!
    const z = positions[v * 3 + 2]!
    if (region === 'trunk') {
      trunkZ += z
      trunkN += 1
      if (y > h(LANDMARKS.crotch) && y < h(LANDMARKS.crest)) {
        pelvisHalfWidth = Math.max(pelvisHalfWidth, Math.abs(x))
      }
      if (Math.abs(x) < 0.006 && y < h(LANDMARKS.crest)) crotchY = Math.min(crotchY, y)
    } else if (region === 'head' || region === 'mouth') {
      headZ += z
      headN += 1
    } else if (region === 'leg') {
      const band = Math.round(y / LEG_BAND)
      const entry = legSum.get(band) ?? { sum: 0, n: 0 }
      entry.sum += Math.abs(x)
      entry.n += 1
      legSum.set(band, entry)
    }
  }

  let earFloor = Infinity
  for (const vertex of ears) earFloor = Math.min(earFloor, positions[vertex * 3 + 1]!)

  const legAxis = (y: number): number => {
    const entry = legSum.get(Math.round(y / LEG_BAND))
    return entry === undefined || entry.n === 0 ? 0 : entry.sum / entry.n
  }

  const frame: Frame = {
    trunkZ: trunkZ / trunkN,
    headZ: headZ / headN,
    ears,
    legAxis,
    earFloor,
    pelvisHalfWidth,
    crotchY,
  }
  verifyLandmarks(joints, toMetres, crotchY)
  return frame
}

/** The rig and the anthropometry should agree to a couple of centimetres. */
function verifyLandmarks(
  joints: BaseMesh['joints'],
  toMetres: (unit: readonly [number, number, number]) => [number, number, number],
  crotchY: number,
): void {
  const expectedCrotch = h(LANDMARKS.crotch)
  if (!Number.isFinite(crotchY) || Math.abs(crotchY - expectedCrotch) > 0.05) {
    throw new Error(
      `the legs part at ${crotchY.toFixed(3)} m but the textbook says ${expectedCrotch.toFixed(3)} m ` +
        '— either the midline probe missed or this is not the mesh this script was written for',
    )
  }
  const checks: ReadonlyArray<[string, string, number, number]> = [
    ['joint-l-shoulder', 'shoulder', LANDMARKS.shoulder, 0.03],
    ['joint-l-upper-leg', 'hipJoint', LANDMARKS.hipJoint, 0.04],
  ]
  for (const [joint, name, fraction, tolerance] of checks) {
    const found = joints.get(joint)
    if (found === undefined) throw new Error(`no ${joint} in the base mesh`)
    const measured = toMetres(found)[1]
    const expected = h(fraction)
    if (Math.abs(measured - expected) > tolerance) {
      throw new Error(
        `landmark ${name} is ${expected.toFixed(3)} m but ${joint} sits at ${measured.toFixed(3)} m ` +
          `— the mesh and LANDMARKS disagree by more than ${tolerance} m`,
      )
    }
  }
}

/* ---------------------------------------------------------------- smoothing */

interface Adjacency {
  readonly offset: Uint32Array
  readonly neighbours: Uint32Array
}

/** The mesh's own edges as a flat CSR pair — count the degrees, then fill. */
function adjacencyOf(vertexCount: number, quads: Uint32Array): Adjacency {
  const degree = new Uint32Array(vertexCount)
  for (const index of quads) degree[index]! += 2
  const offset = new Uint32Array(vertexCount + 1)
  for (let v = 0; v < vertexCount; v += 1) offset[v + 1] = offset[v]! + degree[v]!
  const neighbours = new Uint32Array(offset[vertexCount]!)
  const cursor = offset.slice(0, vertexCount)
  for (let q = 0; q < quads.length; q += 4) {
    for (let corner = 0; corner < 4; corner += 1) {
      const a = quads[q + corner]!
      const b = quads[q + ((corner + 1) % 4)]!
      neighbours[cursor[a]!] = b
      cursor[a]! += 1
      neighbours[cursor[b]!] = a
      cursor[b]! += 1
    }
  }
  return { offset, neighbours }
}

/**
 * Every vertex outside `region` that cannot be reached from the rest of the mesh without
 * crossing it — the holes in a region, which belong to it.
 */
function enclosedBy(region: ReadonlySet<number>, count: number, graph: Adjacency): number[] {
  const seen = new Uint8Array(count)
  const enclosed: number[] = []
  for (let seed = 0; seed < count; seed += 1) {
    if (seen[seed] === 1 || region.has(seed)) continue
    const patch: number[] = []
    const stack = [seed]
    seen[seed] = 1
    let walled = true
    while (stack.length > 0) {
      const v = stack.pop()!
      patch.push(v)
      for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
        const n = graph.neighbours[e]!
        if (region.has(n)) continue
        if (seen[n] === 0) {
          seen[n] = 1
          stack.push(n)
        }
      }
    }
    // The one patch that is most of the mesh is the outside; everything else is a hole.
    if (patch.length > count / 2) walled = false
    if (walled) enclosed.push(...patch)
  }
  return enclosed
}

/** Majority vote over the mesh's own edges, a vertex's own label counting double. */
function smoothLabels(labels: Uint8Array, graph: Adjacency, rounds: number): Uint8Array {
  let current = labels
  const tally = new Uint16Array(ZONE_CODES.length)
  for (let round = 0; round < rounds; round += 1) {
    const next = new Uint8Array(current.length)
    for (let v = 0; v < current.length; v += 1) {
      tally.fill(0)
      const own = current[v]!
      tally[own] = 2
      for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
        tally[current[graph.neighbours[e]!]!]! += 1
      }
      let best = own
      let bestCount = tally[own]!
      for (let z = 0; z < tally.length; z += 1) {
        if (tally[z]! > bestCount) {
          bestCount = tally[z]!
          best = z
        }
      }
      next[v] = best
    }
    current = next
  }
  return current
}

/**
 * Absorbs stray islands into whatever surrounds them.
 *
 * The threshold is **area, not vertex count**, and on this mesh that distinction decides the
 * result rather than merely tidying it. The sculpt spends a third of its vertices on the
 * face and a quarter on the hands, so a hundred vertices is a whole shoulder on the torso
 * and a fingernail on the head. Counting them dissolved shoulders and kept the lining of the
 * mouth; measuring them does the reverse, which is what was wanted.
 *
 * A region never loses its largest patch: it can be reduced to one piece, it can never be
 * dissolved. `lips`, `ears` and `intimate` are legitimately small and would otherwise be the
 * first things any threshold ate.
 */
function despeckle(
  labels: Uint8Array,
  graph: Adjacency,
  vertexArea: Float64Array,
  minimum: number,
): Uint8Array {
  const count = labels.length
  const component = new Int32Array(count).fill(-1)
  const sizes: number[] = []
  const owners: number[] = []
  const stack: number[] = []

  for (let seed = 0; seed < count; seed += 1) {
    if (component[seed] !== -1) continue
    const label = labels[seed]!
    const id = sizes.length
    sizes.push(0)
    owners.push(label)
    component[seed] = id
    stack.push(seed)
    while (stack.length > 0) {
      const v = stack.pop()!
      sizes[id]! += vertexArea[v]!
      for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
        const n = graph.neighbours[e]!
        if (component[n] === -1 && labels[n] === label) {
          component[n] = id
          stack.push(n)
        }
      }
    }
  }

  const largest = new Map<number, number>()
  for (let id = 0; id < sizes.length; id += 1) {
    const champion = largest.get(owners[id]!)
    if (champion === undefined || sizes[id]! > sizes[champion]!) largest.set(owners[id]!, id)
  }

  const out = Uint8Array.from(labels)
  for (let id = 0; id < sizes.length; id += 1) {
    if (sizes[id]! >= minimum || largest.get(owners[id]!) === id) continue
    const tally = new Map<number, number>()
    for (let v = 0; v < count; v += 1) {
      if (component[v] !== id) continue
      for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
        const other = labels[graph.neighbours[e]!]!
        if (other !== owners[id]!) tally.set(other, (tally.get(other) ?? 0) + 1)
      }
    }
    let best = owners[id]!
    let bestCount = 0
    for (const [label, n] of tally) {
      if (n > bestCount) {
        bestCount = n
        best = label
      }
    }
    for (let v = 0; v < count; v += 1) if (component[v] === id) out[v] = best
  }
  return out
}

/* --------------------------------------------------------------------- bake */

interface Baked {
  readonly vertexCount: number
  readonly quads: Uint16Array
  readonly zones: Uint8Array
  readonly positions: Record<StoredForm, Float64Array>
  readonly bounds: { min: [number, number, number]; max: [number, number, number] }
  /** Surface area per region, in square centimetres — the honest measure of a tap target. */
  readonly area: ReadonlyMap<ZoneCode, number>
  /** Connected patches per region: a region a person can find is one piece, or at most two. */
  readonly patches: ReadonlyMap<ZoneCode, number[]>
}

function bake(): Baked {
  const mesh = parseObj(readFileSync(join(CACHE, 'base.obj'), 'utf8'))
  const total = mesh.positions.length / 3
  const count = mesh.bodyVertexCount

  const targets = new Map<string, Float64Array>()
  for (const source of SOURCES) {
    if (!source.file.endsWith('.target')) continue
    targets.set(
      source.file.replace(/\.target$/, ''),
      parseTarget(readFileSync(join(CACHE, source.file), 'utf8'), total),
    )
  }

  const morphed = {} as Record<StoredForm, Float64Array>
  for (const form of STORED) {
    const out = Float64Array.from(mesh.positions)
    const names = TARGETS_OF[form]
    for (const name of names) {
      const delta = targets.get(name)
      if (delta === undefined) throw new Error(`missing target ${name}`)
      for (let i = 0; i < out.length; i += 1) out[i]! += delta[i]! / names.length
    }
    morphed[form] = out
  }

  // One frame for all forms, taken from their midpoint, so switching form changes the body
  // and not where it stands. Feet on the floor, midline at x = 0, and the box centred in z.
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let v = 0; v < count; v += 1) {
    const y = (morphed.feminine[v * 3 + 1]! + morphed.masculine[v * 3 + 1]!) / 2
    const z = (morphed.feminine[v * 3 + 2]! + morphed.masculine[v * 3 + 2]!) / 2
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  const scale = FIGURE_HEIGHT / (maxY - minY)
  const offsetY = -minY * scale
  const offsetZ = -((minZ + maxZ) / 2) * scale
  const toMetres = (unit: readonly [number, number, number]): [number, number, number] => [
    unit[0] * scale,
    unit[1] * scale + offsetY,
    unit[2] * scale + offsetZ,
  ]

  const positions = {} as Record<StoredForm, Float64Array>
  for (const form of STORED) {
    const source = morphed[form]
    const out = new Float64Array(count * 3)
    for (let v = 0; v < count; v += 1) {
      out[v * 3] = source[v * 3]! * scale
      out[v * 3 + 1] = source[v * 3 + 1]! * scale + offsetY
      out[v * 3 + 2] = source[v * 3 + 2]! * scale + offsetZ
    }
    positions[form] = out
  }
  const middle = new Float64Array(count * 3)
  for (let i = 0; i < middle.length; i += 1) {
    middle[i] = (positions.feminine[i]! + positions.masculine[i]!) / 2
  }

  // MakeHuman's quads wind counter-clockwise seen from outside, which is three.js's front
  // face. The signed volume proves it rather than trusting it.
  const quads = Uint16Array.from(mesh.quads)
  let volume = 0
  for (let q = 0; q < quads.length; q += 4) {
    const corners = [quads[q]!, quads[q + 1]!, quads[q + 2]!, quads[q + 3]!]
    for (const [i, j, k] of [
      [0, 1, 2],
      [0, 2, 3],
    ] as const) {
      const a = corners[i]! * 3
      const b = corners[j]! * 3
      const c = corners[k]! * 3
      volume +=
        (middle[a]! * (middle[b + 1]! * middle[c + 2]! - middle[b + 2]! * middle[c + 1]!) -
          middle[a + 1]! * (middle[b]! * middle[c + 2]! - middle[b + 2]! * middle[c]!) +
          middle[a + 2]! * (middle[b]! * middle[c + 1]! - middle[b + 1]! * middle[c]!)) /
        6
    }
  }
  if (volume < 0) {
    for (let q = 0; q < quads.length; q += 4) {
      const swap = quads[q + 1]!
      quads[q + 1] = quads[q + 3]!
      quads[q + 3] = swap
    }
  }

  // Regions.
  const bones = parseDominantBones(readFileSync(join(CACHE, 'weights.mhw'), 'utf8'), count)
  const regions = bones.map(bone => (bone === '' ? null : regionOfBone(bone)))
  // A scale morph has to feather into the scalp around the ear or it would tear the mesh, so
  // its outermost vertices are head rather than ear. The ones it moves *most* are the pinna;
  // a third of the largest displacement cuts the halo off and keeps the whole ear.
  const EAR_CORE = 0.34
  const graph = adjacencyOf(count, mesh.quads)

  const ears = new Set<number>()
  for (const name of EAR_TARGETS) {
    const delta = targets.get(name)
    if (delta === undefined) throw new Error(`missing target ${name}`)
    let largest = 0
    for (let v = 0; v < count; v += 1) {
      largest = Math.max(largest, Math.hypot(delta[v * 3]!, delta[v * 3 + 1]!, delta[v * 3 + 2]!))
    }
    for (let v = 0; v < count; v += 1) {
      const moved = Math.hypot(delta[v * 3]!, delta[v * 3 + 1]!, delta[v * 3 + 2]!)
      if (moved > largest * EAR_CORE) ears.add(v)
    }
  }
  // The morph moves the rim of the ear hardest and the skin it attaches to least, so the
  // core above is a *ring*: it encloses a coin of scalp behind each ear that is not reachable
  // from the rest of the head without crossing the ear. An ear with a hole in it is not an
  // ear, so anything walled in entirely by ear is ear.
  for (const seed of enclosedBy(ears, count, graph)) ears.add(seed)
  if (ears.size < 300 || ears.size > 1200) {
    throw new Error(`the ear morphs cover ${ears.size} vertices, which is not a pair of ears`)
  }
  const frame = makeFrame(middle, count, regions, mesh.joints, toMetres, ears)

  const indexOfZone = new Map<ZoneCode, number>(ZONE_CODES.map((code, i) => [code, i]))
  const raw = new Uint8Array(count)
  const unlabelled: number[] = []
  for (let v = 0; v < count; v += 1) {
    const region = regions[v]
    if (region === null || region === undefined) {
      unlabelled.push(v)
      continue
    }
    const zone = zoneOf(v, region, middle[v * 3]!, middle[v * 3 + 1]!, middle[v * 3 + 2]!, frame)
    raw[v] = indexOfZone.get(zone)!
  }

  // A few vertices are weighted only to bones this map has no opinion about. Grow the
  // labelled surface over them rather than guessing: whatever surrounds them is right.
  const pending = new Set(unlabelled)
  for (let pass = 0; pass < 8 && pending.size > 0; pass += 1) {
    for (const v of [...pending]) {
      for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
        if (!pending.has(graph.neighbours[e]!)) {
          raw[v] = raw[graph.neighbours[e]!]!
          pending.delete(v)
          break
        }
      }
    }
  }

  // A quarter of each quad's area to each of its corners: how much body a vertex speaks for.
  const vertexArea = new Float64Array(count)
  const quadArea = new Float64Array(quads.length / 4)
  for (let q = 0; q < quads.length; q += 4) {
    const corners = [quads[q]!, quads[q + 1]!, quads[q + 2]!, quads[q + 3]!]
    let sum = 0
    for (const [i, j, k] of [
      [0, 1, 2],
      [0, 2, 3],
    ] as const) {
      const a = corners[i]! * 3
      const b = corners[j]! * 3
      const c = corners[k]! * 3
      const ux = middle[b]! - middle[a]!
      const uy = middle[b + 1]! - middle[a + 1]!
      const uz = middle[b + 2]! - middle[a + 2]!
      const vx = middle[c]! - middle[a]!
      const vy = middle[c + 1]! - middle[a + 1]!
      const vz = middle[c + 2]! - middle[a + 2]!
      sum +=
        Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    }
    quadArea[q / 4] = sum
    for (const corner of corners) vertexArea[corner]! += sum / 4
  }

  // 15 cm² is about the smallest patch worth naming: a little larger than a fingertip, and
  // well under the smallest real region on the body.
  const zones = despeckle(smoothLabels(raw, graph, 4), graph, vertexArea, 0.0015)

  // Area, not vertex count: this mesh spends a third of its vertices on the face and a
  // quarter on the hands, so counting them would say the ears are bigger than the back.
  const area = new Map<ZoneCode, number>(ZONE_CODES.map(code => [code, 0]))
  for (let q = 0; q < quads.length; q += 4) {
    const tally = new Map<number, number>()
    for (let corner = 0; corner < 4; corner += 1) {
      const zone = zones[quads[q + corner]!]!
      tally.set(zone, (tally.get(zone) ?? 0) + 1)
    }
    let owner = zones[quads[q]!]!
    let best = 0
    for (const [zone, n] of tally) {
      if (n > best) {
        best = n
        owner = zone
      }
    }
    const code = ZONE_CODES[owner]!
    area.set(code, area.get(code)! + quadArea[q / 4]!)
  }
  for (const [code, value] of area) area.set(code, value * 10000)

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const form of STORED) {
    const source = positions[form]
    for (let i = 0; i < source.length; i += 1) {
      const axis = i % 3
      min[axis] = Math.min(min[axis]!, source[i]!)
      max[axis] = Math.max(max[axis]!, source[i]!)
    }
  }

  const patches = new Map<ZoneCode, number[]>(ZONE_CODES.map(code => [code, []]))
  const seen = new Uint8Array(count)
  for (let seed = 0; seed < count; seed += 1) {
    if (seen[seed] === 1) continue
    const label = zones[seed]!
    let size = 0
    const walk = [seed]
    seen[seed] = 1
    while (walk.length > 0) {
      const v = walk.pop()!
      size += 1
      for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
        const n = graph.neighbours[e]!
        if (seen[n] === 0 && zones[n] === label) {
          seen[n] = 1
          walk.push(n)
        }
      }
    }
    patches.get(ZONE_CODES[label]!)!.push(size)
    if (process.argv.includes('--patches')) {
      let cx = 0
      let cy = 0
      let cz = 0
      let n = 0
      const walk2 = [seed]
      const mark = new Set<number>([seed])
      while (walk2.length > 0) {
        const v = walk2.pop()!
        cx += middle[v * 3]!
        cy += middle[v * 3 + 1]!
        cz += middle[v * 3 + 2]!
        n += 1
        for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
          const nb = graph.neighbours[e]!
          if (!mark.has(nb) && zones[nb] === label) {
            mark.add(nb)
            walk2.push(nb)
          }
        }
      }
      const border = new Map<string, number>()
      for (const v of mark) {
        for (let e = graph.offset[v]!; e < graph.offset[v + 1]!; e += 1) {
          const nb = graph.neighbours[e]!
          if (zones[nb] !== label) {
            const name = ZONE_CODES[zones[nb]!]!
            border.set(name, (border.get(name) ?? 0) + 1)
          }
        }
      }
      console.log(
        `patch ${ZONE_CODES[label]!.padEnd(12)} ${String(size).padStart(5)} at ` +
          `x ${(cx / n).toFixed(3)}  y ${(cy / n).toFixed(3)}  z ${(cz / n).toFixed(3)}  ` +
          `borders ${[...border].sort((a, b) => b[1] - a[1]).map(([k, v2]) => `${k}:${v2}`).join(' ')}`,
      )
    }
  }
  for (const list of patches.values()) list.sort((a, b) => b - a)

  return { vertexCount: count, quads, zones, positions, bounds: { min, max }, area, patches }
}

/* ------------------------------------------------------------------- output */

const MAGIC = 0x464d5754 // 'TWMF'
const VERSION = 1

function encode(baked: Baked): Buffer {
  const header = 6 * 4 + 6 * 4
  const bytes =
    header +
    baked.quads.byteLength +
    baked.vertexCount +
    STORED.length * baked.vertexCount * 3 * 2
  const buffer = Buffer.alloc(bytes)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  let at = 0
  const u32 = (value: number): void => {
    view.setUint32(at, value, true)
    at += 4
  }
  u32(MAGIC)
  u32(VERSION)
  u32(baked.vertexCount)
  u32(baked.quads.length / 4)
  u32(STORED.length)
  u32(ZONE_CODES.length)
  for (const axis of [...baked.bounds.min, ...baked.bounds.max]) {
    view.setFloat32(at, axis, true)
    at += 4
  }

  for (const corner of baked.quads) {
    view.setUint16(at, corner, true)
    at += 2
  }
  for (const zone of baked.zones) view.setUint8(at++, zone)

  // Quantised over one box shared by both forms, so dequantising is a multiply-add per axis
  // with no per-form state, and the midpoint of two quantised forms is still the midpoint.
  const { min, max } = baked.bounds
  for (const form of STORED) {
    const source = baked.positions[form]
    for (let i = 0; i < source.length; i += 1) {
      const axis = i % 3
      const span = max[axis]! - min[axis]!
      const t = span > 0 ? (source[i]! - min[axis]!) / span : 0
      view.setUint16(at, Math.round(Math.min(1, Math.max(0, t)) * 65535), true)
      at += 2
    }
  }
  if (at !== bytes) throw new Error(`wrote ${at} of ${bytes} bytes`)
  return buffer
}

/**
 * The asset ships as base64 inside a module rather than as a file fetched at runtime.
 *
 * It costs eight kilobytes gzipped over the raw bytes, and buys: one artefact instead of a
 * file plus a URL plus a service-worker rule, the same code path in the browser, in vitest
 * and in `tsx` with no environment branch, and a synchronous `buildFigure` — so the canvas
 * effect stays the ordinary three lines it was rather than an async one with a cancellation
 * flag in it.
 */
function emit(buffer: Buffer): string {
  const base64 = buffer.toString('base64')
  const lines: string[] = []
  for (let at = 0; at < base64.length; at += 96) lines.push(`  '${base64.slice(at, at + 96)}',`)
  return `/**
 * The mannequin, baked. Generated by \`app/scripts/bake-figure.ts\` — do not edit.
 *
 * MakeHuman's CC0 \`hm08\` base mesh, morphed to two forms, quantised, with a region on every
 * vertex. See that script for how it is made and \`app/scripts/NOTICE.md\` for the licence.
 */
export const FIGURE_ASSET_BASE64 = [
${lines.join('\n')}
].join('')
`
}

/* --------------------------------------------------------------------- main */

const report = process.argv.includes('--report')

await ensureSources()
const baked = bake()
const buffer = encode(baked)
const module_ = emit(buffer)

console.log(`vertices   ${baked.vertexCount}`)
console.log(`quads      ${baked.quads.length / 4}`)
console.log(
  `asset      ${(buffer.length / 1024).toFixed(0)} KB raw, ` +
    `${(gzipSync(Buffer.from(module_), { level: 9 }).length / 1024).toFixed(0)} KB gzipped as a module`,
)
console.log('regions, by surface area')
const totalArea = [...baked.area.values()].reduce((sum, value) => sum + value, 0)
for (const code of ZONE_CODES) {
  const cm2 = baked.area.get(code)!
  const share = ((cm2 / totalArea) * 100).toFixed(1)
  const pieces = baked.patches.get(code)!
  console.log(
    `  ${code.padEnd(12)} ${cm2.toFixed(0).padStart(5)} cm²  ${share.padStart(5)}%  ` +
      `${String(pieces.length).padStart(2)} piece${pieces.length === 1 ? ' ' : 's'} ${pieces.slice(0, 5).join('/')}` +
      (cm2 < 30 ? '   ← too small to tap' : ''),
  )
}

if (!report) {
  writeFileSync(OUT, module_)
  console.log(`\nwrote ${OUT}`)
}
