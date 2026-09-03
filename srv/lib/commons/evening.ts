/**
 * Dealing an evening — CONTRACTS.md §14.6.
 *
 * Pure: given some places, some ideas and a seed, it returns three cards. No I/O, no clock,
 * no `Math.random`, so the same household asking twice on the same day gets the same three
 * cards and the deck does not reshuffle under a thumb.
 *
 * ## Why three, and why not simply the best three
 *
 * Three because one suggestion is an instruction and three is a choice (ADR-003 §9). Not the
 * best three because "best" is a ranking and a ranking dealt straight is the same evening
 * every night: the top of the list barely moves week to week, so a household would see the
 * same restaurant until they stopped opening the page.
 *
 * So the deal is a **weighted sample from the top of the list**, seeded by the day and the
 * household. Weight falls off with rank, so a better place is likelier — but a place at rank
 * nine still comes up sometimes, which is the entire purpose. This is the "encourage novelty
 * gently" line from the product research made into arithmetic: the nudge is in the sampling
 * weights, not in a banner telling somebody to try something new.
 *
 * ## Why a place they have been to is never hidden
 *
 * Somewhere a household already loves is a good answer to "what shall we do tonight", and an
 * app that hides it to seem clever is an app that has decided it knows better. Visited places
 * are down-weighted, never removed.
 */
import { combineCostBands, COST_BANDS, type CostBand } from './vocabulary'

export interface DealtPlace {
  readonly ID: string
  readonly name: string
  readonly kind: string
  readonly lat: number
  readonly lon: number
  readonly city: string | null
  readonly distance: number | null
  readonly stars: number | null
  readonly households: number
  readonly costBand: CostBand | null
  readonly tags: readonly string[]
}

export interface DealtIdea {
  readonly ID: string
  readonly title: string
  readonly summary: string
  readonly costBand: CostBand | null
  readonly minutes: number | null
}

export interface Evening {
  readonly ID: string
  readonly eat: DealtPlace
  readonly doPlace: DealtPlace | null
  readonly doIdea: DealtIdea | null
  readonly costBand: CostBand
  readonly because: string
}

export interface DealInput {
  /** Somewhere to eat, best first. */
  readonly eat: readonly DealtPlace[]
  /** Something to do, best first. */
  readonly activities: readonly DealtPlace[]
  /** The fallback deck, for when the corpus has nothing to do nearby yet. */
  readonly ideas: readonly DealtIdea[]
  /** Places this household has already rated. Down-weighted, never hidden. */
  readonly visited?: ReadonlySet<string>
  /** Nothing dearer than this, per person, for the evening as a whole. */
  readonly maxCost?: CostBand | null
  /** Stable per household per day: the same question gets the same answer. */
  readonly seed: string
}

/** How many cards a deal produces. Three is the product decision, not a parameter. */
export const CARDS_PER_DEAL = 3

/**
 * How far down the ranking the sampler will reach.
 *
 * Twelve. Small enough that everything dealt is genuinely well-rated, large enough that a
 * household opening the page every Friday for a month does not see the same card twice.
 */
const SAMPLE_DEPTH = 12

/** How much a place already rated by this household is held back. Held back, not removed. */
const VISITED_WEIGHT = 0.35

/** A place further than this from the meal is a different evening, not the same one. */
const PAIR_RADIUS_M = 2_500

/* ------------------------------------------------------------------ chance */

/** FNV-1a, so a seed string becomes a 32-bit number the same way on every engine. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * Deterministic and seeded rather than `Math.random`, because a card deck that changes on
 * every render is a card deck nobody can point at and say "that one". The whole feature
 * depends on the deal being stable for the day.
 */
function random(seed: string): () => number {
  let state = hashSeed(seed)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Draws `count` distinct items, likelier at the front of the list.
 *
 * Weight `1/(rank + 2)` — a gentle decay, not an exponential one. At the extremes: rank 0 is
 * about four times likelier than rank 10, which is enough to feel curated and not enough to
 * make ranks 6–11 decorative.
 */
function sample<T>(
  items: readonly T[],
  count: number,
  next: () => number,
  weightOf: (item: T, rank: number) => number,
): T[] {
  const pool = items.slice(0, SAMPLE_DEPTH).map((item, rank) => ({
    item,
    weight: Math.max(1e-6, weightOf(item, rank) / (rank + 2)),
  }))
  const drawn: T[] = []
  while (drawn.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0)
    let target = next() * total
    let index = pool.length - 1
    for (let i = 0; i < pool.length; i += 1) {
      target -= pool[i]!.weight
      if (target <= 0) {
        index = i
        break
      }
    }
    drawn.push(pool[index]!.item)
    pool.splice(index, 1)
  }
  return drawn
}

/* ------------------------------------------------------------------- prose */

const TAG_PHRASE: Record<string, string> = {
  quiet: 'quiet enough to talk',
  lively: 'a lively room',
  outdoor: 'tables outside',
  view: 'worth it for the view',
  easy_to_talk: 'easy to talk in',
  book_ahead: 'book ahead',
  no_booking_needed: 'no booking needed',
  late_open: 'open late',
  step_free: 'step-free',
  dog_ok: 'dogs welcome',
  great_food: 'the food is the point',
  good_value: 'good value',
  walk_after: 'somewhere to walk afterwards',
  first_date: 'kind to a first date',
  big_group: 'takes a big group',
  rainy_day: 'fine in the rain',
  special_occasion: 'for something worth marking',
  surprise_worked: 'worked as a surprise',
}

/**
 * The line under the card.
 *
 * It says how many households and what they agreed on — never a rank. "Worked for 12
 * households" is a fact about the corpus; "#3 in Zürich" is a league table, and the product
 * research is explicit that this app celebrates rather than ranks.
 */
export function because(place: DealtPlace): string {
  const phrase = place.tags.map(tag => TAG_PHRASE[tag]).find(found => found !== undefined)
  const households = `${place.households} household${place.households === 1 ? '' : 's'}`
  return phrase === undefined ? `Worked for ${households}` : `${phrase} — ${households}`
}

/* -------------------------------------------------------------------- deal */

function withinBudget(band: CostBand, ceiling: CostBand | null | undefined): boolean {
  if (ceiling === null || ceiling === undefined) return true
  return COST_BANDS.indexOf(band) <= COST_BANDS.indexOf(ceiling)
}

function metresBetween(a: DealtPlace, b: DealtPlace): number {
  // Flat-earth is fine over the couple of kilometres this ever compares, and it keeps this
  // module free of a dependency it would otherwise need for one line.
  const latMetres = (b.lat - a.lat) * 111_320
  const lonMetres = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(latMetres, lonMetres)
}

/**
 * Three evenings, or fewer when the corpus cannot honestly fill three.
 *
 * Returning two cards when only two places are worth suggesting is the right answer.
 * Padding the deck with something bad to reach three is how a recommendation surface stops
 * being believed.
 */
export function dealEvenings(input: DealInput): Evening[] {
  const next = random(input.seed)
  const visited = input.visited ?? new Set<string>()
  const weight = (place: DealtPlace): number => (visited.has(place.ID) ? VISITED_WEIGHT : 1)

  const meals = sample(input.eat, CARDS_PER_DEAL, next, weight)
  const activities = sample(input.activities, CARDS_PER_DEAL * 2, next, weight)
  const used = new Set<string>()
  const evenings: Evening[] = []

  for (const eat of meals) {
    // Something to do that is near enough to be the same evening, cheapest fit first among
    // the ones sampled — the sampling already decided quality, so this only decides reach.
    const nearby = activities
      .filter(place => !used.has(place.ID) && metresBetween(eat, place) <= PAIR_RADIUS_M)
      .sort((a, b) => metresBetween(eat, a) - metresBetween(eat, b))

    let doPlace: DealtPlace | null = null
    let doIdea: DealtIdea | null = null
    let combined: CostBand = eat.costBand ?? 'free'

    for (const candidate of nearby) {
      const total = combineCostBands(eat.costBand, candidate.costBand)
      if (withinBudget(total, input.maxCost)) {
        doPlace = candidate
        combined = total
        break
      }
    }

    if (doPlace === null) {
      // Nothing nearby the corpus knows about, or nothing that fits — fall back to the deck,
      // which is why the deck exists. A card with a meal and no idea is half a card.
      const idea = input.ideas.find(candidate =>
        withinBudget(combineCostBands(eat.costBand, candidate.costBand), input.maxCost),
      )
      if (idea !== undefined) {
        doIdea = idea
        combined = combineCostBands(eat.costBand, idea.costBand)
      }
    }

    if (!withinBudget(combined, input.maxCost)) continue
    if (doPlace !== null) used.add(doPlace.ID)

    evenings.push({
      ID: `${input.seed}:${eat.ID}`,
      eat,
      doPlace,
      doIdea,
      costBand: combined,
      because: because(eat),
    })
  }

  return evenings
}
