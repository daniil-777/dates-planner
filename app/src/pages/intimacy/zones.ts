/**
 * The nineteen regions of the figure — CONTRACTS.md §13.1, and the TypeScript half of it.
 *
 * This list is shared with the CDS model and the service guard, so it is additive-only:
 * a code that disappears from here orphans stored rows, and one that appears without
 * appearing in the renderer can never be picked. `ZONE_CODES` is exported as a tuple so
 * `ZoneCode` is a union of literals rather than `string`, which is what makes a typo in a
 * zone name a compile error instead of a region that silently never lights up.
 */

export const ZONE_CODES = [
  'hair',
  'face',
  'lips',
  'ears',
  'neck',
  'shoulders',
  'chest',
  'stomach',
  'upperBack',
  'lowerBack',
  'hips',
  'glutes',
  'arms',
  'hands',
  'thighs',
  'innerThighs',
  'calves',
  'feet',
  'intimate',
] as const

export type ZoneCode = (typeof ZONE_CODES)[number]

const ZONE_SET: ReadonlySet<string> = new Set(ZONE_CODES)

/** Narrows a code that arrived from the server, which is `string` as far as the client knows. */
export function isZoneCode(value: unknown): value is ZoneCode {
  return typeof value === 'string' && ZONE_SET.has(value)
}

/**
 * What each region is called on screen.
 *
 * Plain anatomical words. The alternative — coy euphemism — reads as embarrassed, and a
 * tool two people use to talk about this should not be the most embarrassed party in the
 * conversation.
 */
export const ZONE_LABEL: Record<ZoneCode, string> = {
  hair: 'Hair',
  face: 'Face',
  lips: 'Lips',
  ears: 'Ears',
  neck: 'Neck',
  shoulders: 'Shoulders',
  chest: 'Chest',
  stomach: 'Stomach',
  upperBack: 'Upper back',
  lowerBack: 'Lower back',
  hips: 'Hips',
  glutes: 'Behind',
  arms: 'Arms',
  hands: 'Hands',
  thighs: 'Thighs',
  innerThighs: 'Inner thighs',
  calves: 'Calves',
  feet: 'Feet',
  intimate: 'Intimate',
}

/** Reading order for the list beside the figure: head down, front before back. */
export const ZONE_ORDER: readonly ZoneCode[] = [
  'hair',
  'face',
  'lips',
  'ears',
  'neck',
  'shoulders',
  'arms',
  'hands',
  'chest',
  'stomach',
  'upperBack',
  'lowerBack',
  'hips',
  'glutes',
  'intimate',
  'innerThighs',
  'thighs',
  'calves',
  'feet',
]

/* ------------------------------------------------------------------ levels */

/**
 * CONTRACTS.md §13.2. There is deliberately no 0: a region nobody has said anything about
 * carries no row at all, which is a different state from one marked "rather not", and the
 * service rejects a stored 0 rather than let the two blur together.
 */
export const LEVELS = [-1, 1, 2, 3] as const
export type Level = (typeof LEVELS)[number]

export function isLevel(value: unknown): value is Level {
  return value === -1 || value === 1 || value === 2 || value === 3
}

export interface LevelSpec {
  level: Level
  label: string
  /** The word used in a sentence about somebody else's map, e.g. "Ada would rather not". */
  phrase: string
  /** Fill for the region on the figure and the swatch in the list. */
  colour: string
  /** Readable on `colour` in both themes. */
  ink: string
}

/**
 * Four steps, and only the top three share a hue ramp.
 *
 * "Rather not" is deliberately outside that ramp rather than at the cold end of it: it is
 * not a small amount of yes, and colouring it as one would make the single most important
 * mark on the map the easiest to misread at a glance.
 */
export const LEVEL_SPECS: readonly LevelSpec[] = [
  { level: -1, label: 'Rather not', phrase: 'would rather not', colour: '#5B738B', ink: '#ffffff' },
  { level: 1, label: 'Gently', phrase: 'likes gently', colour: '#F5A9D0', ink: '#3d1029' },
  { level: 2, label: 'Yes', phrase: 'likes', colour: '#E8478E', ink: '#ffffff' },
  { level: 3, label: 'Favourite', phrase: 'loves', colour: '#B02A6F', ink: '#ffffff' },
]

const BY_LEVEL = new Map<Level, LevelSpec>(LEVEL_SPECS.map(spec => [spec.level, spec]))

export function levelSpec(level: Level): LevelSpec {
  const found = BY_LEVEL.get(level)
  // Every Level has a spec; the fallback exists so this returns a value rather than
  // `LevelSpec | undefined` and forces a null check at twenty call sites.
  return found ?? LEVEL_SPECS[2]!
}

/* -------------------------------------------------------------------- form */

/**
 * Which mannequin to draw. CONTRACTS.md §13.5: chosen per person for their own map, and
 * emphatically not an orientation field — the pairing two people see is just their two
 * choices side by side.
 */
export const FORMS = ['feminine', 'masculine', 'neutral'] as const
export type BodyForm = (typeof FORMS)[number]

export function isBodyForm(value: unknown): value is BodyForm {
  return value === 'feminine' || value === 'masculine' || value === 'neutral'
}

export const FORM_LABEL: Record<BodyForm, string> = {
  feminine: 'Feminine',
  masculine: 'Masculine',
  neutral: 'Neutral',
}
