/**
 * The shared words of the commons — CONTRACTS.md §14.2.
 *
 * Tag codes, cost bands and place kinds are the same strings in CDS, in this file and in
 * the frontend, exactly like the category codes in §1.1, and for the same reason: a code
 * that disappears orphans stored rows, and one that appears in only half the stack can
 * never be picked. **Additive changes only.**
 *
 * Two things are deliberately not here. There is no tag describing *who* was there — no
 * "date night for two", no group size, nothing about a household's shape — because
 * ADR-002 §6 refuses to store that and ADR-003 §5 refuses to let it back in through the
 * commons. And there is no sentiment tag: that is what the stars are for, and a chip
 * saying "bad service" is a complaint with a household's evening attached to it.
 */

/**
 * What a chip can say. Grouped only for the reader; the wire format is the flat code.
 *
 * Every one of these answers "what would I want to know before going", which is the test
 * for adding another. "Nice interior" fails it — everybody says that. "Book ahead" passes.
 */
export const PLACE_TAGS = [
  // What it is like to be there
  'quiet',
  'lively',
  'outdoor',
  'view',
  'easy_to_talk',
  // What it is like to get in
  'book_ahead',
  'no_booking_needed',
  'late_open',
  'step_free',
  'dog_ok',
  // What it is good for
  'great_food',
  'good_value',
  'walk_after',
  'first_date',
  'big_group',
  'rainy_day',
  'special_occasion',
  'surprise_worked',
] as const

export type PlaceTag = (typeof PLACE_TAGS)[number]

const TAG_SET: ReadonlySet<string> = new Set(PLACE_TAGS)

export function isPlaceTag(value: unknown): value is PlaceTag {
  return typeof value === 'string' && TAG_SET.has(value)
}

/** How many chips one rating may carry. Enough to be useful, few enough to stay a choice. */
export const MAX_TAGS_PER_RATING = 6

/**
 * Cost bands, **per person**.
 *
 * Per person and not per couple, because nothing in this app may assume a household is two
 * people — `Groups.kind` runs from `couple` to `family` and the roster has no maximum. A
 * band rather than a price because the number comes from what households recorded paying,
 * and a precise figure would be a claim about a menu nobody here has read.
 */
export const COST_BANDS = ['free', 'under_15', 'c15_30', 'c30_60', 'c60_120', 'over_120'] as const

export type CostBand = (typeof COST_BANDS)[number]

const COST_SET: ReadonlySet<string> = new Set(COST_BANDS)

export function isCostBand(value: unknown): value is CostBand {
  return typeof value === 'string' && COST_SET.has(value)
}

/** Inclusive lower and exclusive upper bound of each band, in the household's currency. */
export const COST_RANGE: Record<CostBand, { from: number; to: number | null }> = {
  free: { from: 0, to: 1 },
  under_15: { from: 1, to: 15 },
  c15_30: { from: 15, to: 30 },
  c30_60: { from: 30, to: 60 },
  c60_120: { from: 60, to: 120 },
  over_120: { from: 120, to: null },
}

/** The band an actual per-person amount falls in — used to seed a rating from a real expense. */
export function costBandOf(perPerson: number): CostBand {
  if (!Number.isFinite(perPerson) || perPerson < 1) return 'free'
  for (const band of COST_BANDS) {
    const { to } = COST_RANGE[band]
    if (to !== null && perPerson < to) return band
  }
  return 'over_120'
}

export const PLACE_KINDS = [
  'restaurant',
  'cafe',
  'bar',
  'activity',
  'outdoors',
  'culture',
  'shop',
  'other',
] as const

export type PlaceKind = (typeof PLACE_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(PLACE_KINDS)

export function isPlaceKind(value: unknown): value is PlaceKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

/** The kinds a card treats as "somewhere to eat" when it assembles an evening. */
export const EATING_KINDS: readonly PlaceKind[] = ['restaurant', 'cafe', 'bar']

/**
 * How many distinct households must have rated a place before anybody sees its stars, its
 * chips or its tips — ADR-003 §5.
 *
 * Three, and the reason is concrete rather than conventional: with one rating, "the only
 * household that goes to this bar gave it two stars" identifies a household to anybody who
 * knows where they drink. With three it does not. It gates the tips especially, because
 * prose is the part that leaks.
 */
export const ANONYMITY_THRESHOLD = 3

/** The longest a tip may be. Long enough for a sentence, short enough not to be a story. */
export const MAX_TIP_LENGTH = 240
