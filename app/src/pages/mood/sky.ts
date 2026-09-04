/*
 * The weather, and the face, as arithmetic.
 *
 * Everything visual on the mood picker is a pure function of one number — the slider's
 * 0…100 — and all of those functions live here, with no DOM and no React, so they can be
 * tested by reading them rather than by screenshotting them.
 *
 * ## Why 0…100 in front of a 1…5 table
 *
 * `db/schema.cds` pins `Moods.level` to `@assert.range: [1, 5]` and the service refuses
 * anything else, deliberately: five faces fit under a thumb and a mood is a glance rather
 * than a survey. None of that changes. What the slider adds is *resolution in the gesture*
 * — a face that morphs across a hundred steps as your thumb travels says something a
 * five-way radio group cannot, which is that this is a continuum and you are somewhere on
 * it. The value is rounded to a level at the moment of saving and never before, so the
 * stored scale, the ribbon, the history and every existing row are untouched.
 *
 * The bands are therefore 25 wide and centred on the stops: 0…12 is Rough, 13…37 is Low,
 * and so on. {@link valueForLevel} returns the centre of a band, which is what the camera
 * path needs when a detected level has to be shown on a continuous control.
 *
 * ## Why keyframes rather than one interpolation
 *
 * A storm is not a dim sunny day. Going from one to the other by mixing two colours passes
 * through a grey-blue that is neither, so the sky is built from four *measured* skies —
 * thunderstorm, overcast rain, breaking cloud, clear noon — and the value picks a point
 * between the two it falls among. Same for the face: sad, neutral and delighted are three
 * different arrangements of the same six shapes rather than two ends of one line.
 */

/* ------------------------------------------------------------------ *
 *  Small arithmetic
 * ------------------------------------------------------------------ */

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

/**
 * A ramp with flat ends.
 *
 * Used everywhere a thing should start and stop *gently* — the sun does not begin rising
 * the instant the slider leaves zero, and rain does not stop dead. A linear ramp reads as
 * mechanical for exactly this reason: the eye sees the corner where it starts.
 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 === edge0) return value < edge0 ? 0 : 1
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** Two decimal places. SVG path data does not need more, and shorter strings diff better. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/* ------------------------------------------------------------------ *
 *  Colour
 * ------------------------------------------------------------------ */

export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map(character => character + character)
          .join('')
      : clean
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

export function rgbToCss({ r, g, b }: Rgb): string {
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`
}

/**
 * Mix two colours in sRGB.
 *
 * Not a perceptual space, and that is the right call here rather than a shortcut: every
 * pair this mixes is a pair of *adjacent keyframes* — two blue-greys, or a blue and the
 * blue next to it — where sRGB and OKLab land within a shade of each other. The keyframes
 * are close enough together that the space stops mattering, which is the reason for having
 * four of them.
 */
export function mix(from: string, to: string, amount: number): string {
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  const t = clamp01(amount)
  return rgbToCss({
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  })
}

/* ------------------------------------------------------------------ *
 *  The scale
 * ------------------------------------------------------------------ */

/** The slider's range. Both ends inclusive. */
export const VALUE_MIN = 0
export const VALUE_MAX = 100

/** Where the five stored levels sit on it. */
export const BAND = (VALUE_MAX - VALUE_MIN) / 4

/**
 * The 1…5 this value would be saved as.
 *
 * Nearest stop, so the bands are 25 wide and the boundaries fall at 12.5, 37.5, 62.5 and
 * 87.5 — a value is never more than half a band from the level it will become.
 */
export function levelForValue(value: number): number {
  const t = clamp01((value - VALUE_MIN) / (VALUE_MAX - VALUE_MIN))
  return Math.min(5, Math.max(1, Math.round(t * 4) + 1))
}

/** The centre of a level's band — where the slider should sit to mean exactly that level. */
export function valueForLevel(level: number): number {
  const safe = Math.min(5, Math.max(1, Math.round(level)))
  return VALUE_MIN + (safe - 1) * BAND
}

/** The app's word for a level, matching `MOOD_COLOURS[level].word` in `palette.ts`. */
export const LEVEL_WORDS: Record<number, string> = {
  1: 'Rough',
  2: 'Low',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
}

export function wordForValue(value: number): string {
  return LEVEL_WORDS[levelForValue(value)] ?? 'Okay'
}

/* ------------------------------------------------------------------ *
 *  The sky
 * ------------------------------------------------------------------ */

interface SkyKey {
  at: number
  /** Zenith — the top of the frame. */
  top: string
  upper: string
  mid: string
  /** The band just above the horizon, which is where the warmth arrives. */
  horizon: string
}

/**
 * Four skies, in order.
 *
 * Sampled to read as a specific kind of weather rather than as "dark blue" and "light
 * blue". The storm is desaturated and slightly green — that bruised colour a sky goes
 * before it breaks — rather than navy, which reads as night. The clear sky's horizon is
 * warm and its zenith is deep, because a real sky is darkest overhead and that single fact
 * is most of what makes a painted one look painted.
 */
const SKIES: readonly SkyKey[] = [
  { at: 0, top: '#0d1116', upper: '#19212a', mid: '#28323c', horizon: '#3b4650' },
  { at: 0.34, top: '#333f4b', upper: '#495663', mid: '#69757f', horizon: '#919aa1' },
  { at: 0.68, top: '#2d6ba6', upper: '#5a94c5', mid: '#9cbfda', horizon: '#d8e0e4' },
  { at: 1, top: '#0a5cc0', upper: '#3a92e4', mid: '#8ec6f3', horizon: '#ffe2ab' },
]

/** The pair of keyframes a position falls between, and how far it is across them. */
function span<T extends { at: number }>(keys: readonly T[], t: number): [T, T, number] {
  const clamped = clamp01(t)
  for (let index = 0; index < keys.length - 1; index += 1) {
    const from = keys[index]!
    const to = keys[index + 1]!
    if (clamped <= to.at) {
      const width = to.at - from.at
      return [from, to, width === 0 ? 0 : (clamped - from.at) / width]
    }
  }
  const last = keys[keys.length - 1]!
  return [last, last, 0]
}

export interface Weather {
  /** 0…1, the slider normalised. Everything below derives from it. */
  t: number
  /** Four stops, zenith first, for the sky's vertical gradient. */
  sky: { top: string; upper: string; mid: string; horizon: string }
  /** 0…1. How present the sun is — its disc, its glow and its rays all scale on this. */
  sun: number
  /** Where the sun's centre sits in the 0…300 scene, counting down from the top. */
  sunY: number
  /** 0…1. How much rain is falling. Drives the streak layers' opacity and speed. */
  rain: number
  /** 0…1. Lightning only happens above zero, and its frequency scales with it. */
  storm: number
  /** 0…1. How much of the sky the heavy cloud deck covers. */
  cover: number
  /** The two ends of a cloud's own vertical shading — lit top, shadowed underside. */
  cloudLit: string
  cloudShade: string
  /** 0…1. The small fair-weather wisps that only exist once the deck has gone. */
  wisp: number
  /** Seconds for one drift of the slowest cloud layer. Weather has energy when it is bright. */
  drift: number
  /** A warm wash laid over the whole scene once the sun is up, 0…1. */
  warmth: number
}

export function weatherFor(value: number): Weather {
  const t = clamp01((value - VALUE_MIN) / (VALUE_MAX - VALUE_MIN))
  const [from, to, amount] = span(SKIES, t)

  // The sun clears the cloud deck rather than fading up through it, so it starts late and
  // arrives quickly. `smoothstep` twice is deliberate — the second application puts the
  // steep part of the curve in the middle, which is where the deck is breaking.
  const sunPresence = smoothstep(0, 1, smoothstep(0.34, 0.9, t))

  return {
    t,
    sky: {
      top: mix(from.top, to.top, amount),
      upper: mix(from.upper, to.upper, amount),
      mid: mix(from.mid, to.mid, amount),
      horizon: mix(from.horizon, to.horizon, amount),
    },
    sun: sunPresence,
    // Rises from behind the cloud line to a little above the middle of the frame. It never
    // reaches the top: a sun in the corner of the sky is a composition, and a sun dead
    // centre is a logo.
    sunY: round(lerp(244, 76, sunPresence)),
    // Rain stops before the cloud does, which is the order it happens in. The exponent
    // keeps it heavy across the bottom third rather than thinning out immediately.
    rain: Math.pow(clamp01((0.52 - t) / 0.52), 0.75),
    storm: clamp01((0.2 - t) / 0.2),
    cover: 1 - smoothstep(0.28, 0.96, t),
    cloudLit: mix('#39424e', '#ffffff', smoothstep(0.1, 0.85, t)),
    cloudShade: mix('#12161c', '#c3d3e2', smoothstep(0.1, 0.85, t)),
    wisp: smoothstep(0.62, 0.95, t),
    drift: round(lerp(120, 54, t)),
    warmth: smoothstep(0.55, 1, t),
  }
}

/* ------------------------------------------------------------------ *
 *  The face
 * ------------------------------------------------------------------ */

/*
 * Geometry notes.
 *
 * The face is drawn in a 240×240 box with the head centred at (120, 116) and a radius of
 * 84. Every number below is in that space. Nothing here is a magic constant that was
 * nudged until it looked right and then left unexplained — where a number is a judgement
 * call it says so.
 */
const CX = 120
const CY = 116
export const HEAD_R = 84

/** Eye centres, mirrored about the vertical axis. */
const EYE_DX = 32
const EYE_Y = 98

/** The mouth's baseline and half-width. */
const MOUTH_Y = 156
const MOUTH_HALF = 40

interface FaceKey {
  at: number
  /** How far the eye's upper edge bows up from its centre. Larger is a wider-open eye. */
  eyeTop: number
  /** How far the lower edge bows *down*. Negative bows up, which is what makes a crescent. */
  eyeBottom: number
  /** Half-width of the eye. */
  eyeHalf: number
  /** How much of the eye the upper lid covers, 0…1. The sad droop. */
  lid: number
  /** Vertical offset of the brow's inner end. Negative is up — the worried shape. */
  browInner: number
  /** Vertical offset of the brow's outer end. */
  browOuter: number
  /** How far the brow's midpoint arches above the line between its ends. */
  browArch: number
  /** The whole brow's distance above the eye. */
  browLift: number
  /** How far the mouth's midpoint sits below its corners. Negative is a frown. */
  mouthCurve: number
  /** The gap between upper and lower lip. Zero is a closed line. */
  mouthOpen: number
  /** Half-width of the mouth. */
  mouthHalf: number
}

/**
 * Three arrangements, not two ends.
 *
 * The middle key matters more than either end. Interpolating straight from a frown to a
 * grin takes the mouth through a flat line *and the eyes through nothing at all* — they
 * would simply grow. Pinning neutral in the middle means the eyes open on the way up and
 * then close into the crescent of a real grin, which is the shape a face actually makes
 * and the reason the top of the slider reads as delight rather than as surprise.
 *
 * The crescent falls out of the arithmetic rather than being drawn as a special case: at
 * `delighted` both edges of the eye bow upward (`eyeBottom` is negative), so the filled
 * region between them is a shape arcing up — the ^ ^ of a face laughing with its eyes.
 */
const FACES: readonly FaceKey[] = [
  {
    at: 0,
    eyeTop: 7,
    eyeBottom: 10,
    eyeHalf: 11,
    lid: 0.62,
    browInner: -11,
    browOuter: 8,
    browArch: 1,
    browLift: 0,
    mouthCurve: -22,
    mouthOpen: 0,
    mouthHalf: 30,
  },
  {
    at: 0.5,
    eyeTop: 14,
    eyeBottom: 14,
    eyeHalf: 13,
    lid: 0.08,
    browInner: 0,
    browOuter: 0,
    browArch: 4,
    browLift: -3,
    mouthCurve: 2,
    mouthOpen: 0,
    mouthHalf: 34,
  },
  {
    at: 1,
    eyeTop: 20,
    eyeBottom: -7,
    eyeHalf: 16,
    lid: 0,
    browInner: 4,
    browOuter: -7,
    browArch: 9,
    browLift: -9,
    mouthCurve: 34,
    mouthOpen: 30,
    mouthHalf: 44,
  },
]

export interface Face {
  /** 0…1, the slider normalised. */
  t: number
  /** Path data for one eye, drawn about its own centre at the origin. */
  eye: string
  /** The drooping upper lid, drawn about the same origin. Faded out by `lidOpacity`. */
  lidPath: string
  lidOpacity: number
  /** How visible the pupil is. It goes as the eye closes into a crescent. */
  pupil: number
  /** Where the eye centres are. */
  eyeDx: number
  eyeY: number
  /** One brow, drawn about the eye's centre, for the right-hand side. Mirror it for the left. */
  brow: string
  /** The mouth, as a closed fill: a lip line that opens into a mouth. */
  mouth: string
  /**
   * The upper teeth — the mouth's own outline lifted, so it follows the smile rather than
   * cutting a straight bar across it. Clipped to {@link mouth} by the component, which is
   * what leaves only the band hugging the upper lip.
   */
  teeth: string
  /**
   * How visible the teeth are. Separate from the tongue and quicker, because teeth at
   * half opacity over a dark mouth are pink — and a mouth full of pink is not a grin.
   */
  teethOpacity: number
  /** The tongue, and how visible it is. Only present once the mouth is properly open. */
  tongue: string
  tongueOpacity: number
  /** Blush, 0…1. */
  blush: number
  /** The head's own two-stop shading. It brightens with the sky, so the face catches light. */
  skinLit: string
  skinShade: string
}

export function faceFor(value: number): Face {
  const t = clamp01((value - VALUE_MIN) / (VALUE_MAX - VALUE_MIN))
  const [from, to, amount] = span(FACES, t)
  const k = (field: keyof Omit<FaceKey, 'at'>): number => lerp(from[field], to[field], amount)

  const eyeHalf = k('eyeHalf')
  const eyeTop = k('eyeTop')
  const eyeBottom = k('eyeBottom')
  const lid = k('lid')

  // A quadratic through the two corners, once over the top and once back under the bottom.
  // The control point sits at twice the intended bow because a quadratic reaches half way
  // to its control — the standard correction, and the reason these numbers read as the
  // actual height of the curve.
  const eye =
    `M ${round(-eyeHalf)} 0` +
    ` Q 0 ${round(-eyeTop * 2)} ${round(eyeHalf)} 0` +
    ` Q 0 ${round(eyeBottom * 2)} ${round(-eyeHalf)} 0 Z`

  // The lid is the same top curve dropped down over the eye, so its lower edge always
  // matches the eye's own shape rather than cutting a straight line across it.
  const lidDrop = lerp(-eyeTop, eyeBottom, lid)
  const lidPath =
    `M ${round(-eyeHalf - 2)} ${round(-eyeTop - 3)}` +
    ` L ${round(eyeHalf + 2)} ${round(-eyeTop - 3)}` +
    ` L ${round(eyeHalf)} ${round(lidDrop)}` +
    ` Q 0 ${round(lidDrop - eyeTop)} ${round(-eyeHalf)} ${round(lidDrop)} Z`

  const browLift = k('browLift')
  const browInner = k('browInner')
  const browOuter = k('browOuter')
  const browArch = k('browArch')
  const browY = -eyeTop - 20 + browLift

  // Written for the right eye, inner end first. The left is the same path mirrored, so the
  // two brows can never drift out of agreement with each other.
  const brow =
    `M ${round(-eyeHalf - 3)} ${round(browY + browInner)}` +
    ` Q ${round(eyeHalf * 0.1)} ${round(browY + (browInner + browOuter) / 2 - browArch * 2)}` +
    ` ${round(eyeHalf + 8)} ${round(browY + browOuter)}`

  const mouthHalf = k('mouthHalf')
  const mouthCurve = k('mouthCurve')
  const mouthOpen = k('mouthOpen')
  // The lip keeps a thickness of its own so that a closed mouth is still a drawn line
  // rather than a zero-area path that vanishes. Opening the mouth adds to it.
  const thickness = 8 + mouthOpen

  const mouth =
    `M ${round(-mouthHalf)} 0` +
    ` Q 0 ${round(mouthCurve * 2)} ${round(mouthHalf)} 0` +
    ` Q 0 ${round(mouthCurve * 2 + thickness * 2)} ${round(-mouthHalf)} 0 Z`

  // The same outline lifted by half a lip. Clipped to the mouth it leaves a white band
  // along the top that curves with the smile — a straight bar of teeth across a curved
  // mouth is the tell that gives away most drawn grins.
  const teethLift = thickness * 0.52
  const teeth =
    `M ${round(-mouthHalf)} ${round(-teethLift)}` +
    ` Q 0 ${round(mouthCurve * 2 - teethLift)} ${round(mouthHalf)} ${round(-teethLift)}` +
    ` Q 0 ${round(mouthCurve * 2 + thickness * 2 - teethLift)}` +
    ` ${round(-mouthHalf)} ${round(-teethLift)} Z`

  // A tongue only makes sense inside an open mouth, and it is clipped to the mouth shape by
  // the component, so it can be a plain rounded blob here.
  const tongueW = mouthHalf * 0.52
  const tongueTop = mouthCurve + thickness * 0.35
  const tongue =
    `M ${round(-tongueW)} ${round(tongueTop)}` +
    ` Q 0 ${round(tongueTop + thickness * 2.2)} ${round(tongueW)} ${round(tongueTop)}` +
    ` Q 0 ${round(tongueTop + thickness * 0.5)} ${round(-tongueW)} ${round(tongueTop)} Z`

  return {
    t,
    eye,
    lidPath,
    lidOpacity: clamp01(lid * 1.6),
    // The pupil fades as the eye becomes a crescent, because a crescent has no opening for
    // one to sit in and a dot floating in it reads as a mistake.
    pupil: 1 - smoothstep(0.72, 0.96, t),
    eyeDx: EYE_DX,
    eyeY: EYE_Y,
    brow,
    mouth,
    teeth,
    teethOpacity: smoothstep(0.58, 0.78, t),
    tongue,
    tongueOpacity: smoothstep(0.68, 0.92, t),
    blush: smoothstep(0.58, 1, t),
    // The face is lit by the same sky it sits in: dull ochre under the storm, full warm
    // yellow in the sun. It is the one place the two halves of this screen touch.
    skinLit: mix('#b08a3c', '#ffd54a', smoothstep(0.05, 0.85, t)),
    skinShade: mix('#7c5f26', '#eda320', smoothstep(0.05, 0.85, t)),
  }
}

/** Where the mouth and eyes live, for the component that has to place them. */
export const FACE_LAYOUT = { cx: CX, cy: CY, r: HEAD_R, mouthY: MOUTH_Y, mouthHalf: MOUTH_HALF }
