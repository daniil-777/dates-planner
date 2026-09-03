/**
 * The commons vocabulary, frontend half — CONTRACTS.md §14.2.
 *
 * The same strings as `srv/lib/commons/vocabulary.ts`, exactly as the category codes in §1.1
 * are the same in CDS, Python and TypeScript. Codes are the wire format and are
 * **additive-only**; the labels beside them are what a person reads and may be reworded
 * freely, because nothing is stored by its label.
 *
 * Two absences are deliberate and are the point of this file rather than an omission from it.
 * There is no chip describing *who* was there — no group size, no couple type, nothing about
 * a household's shape — because ADR-002 §6 refuses to store that and ADR-003 §5 refuses to
 * let it back in through the commons. And there is no negative chip: that is what the stars
 * are for, and "bad service" is a complaint with somebody's evening attached to it.
 */

export const PLACE_TAGS = [
  'quiet',
  'lively',
  'outdoor',
  'view',
  'easy_to_talk',
  'book_ahead',
  'no_booking_needed',
  'late_open',
  'step_free',
  'dog_ok',
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

/**
 * What a chip says on screen.
 *
 * Written as a phrase somebody would actually say — "worth booking", not "Booking Required".
 * A chip is a fragment of a sentence about a place, and reads better as one.
 */
export const TAG_LABEL: Record<PlaceTag, string> = {
  quiet: 'Quiet',
  lively: 'Lively',
  outdoor: 'Tables outside',
  view: 'A view',
  easy_to_talk: 'Easy to talk',
  book_ahead: 'Worth booking',
  no_booking_needed: 'Just turn up',
  late_open: 'Open late',
  step_free: 'Step-free',
  dog_ok: 'Dogs welcome',
  great_food: 'The food',
  good_value: 'Good value',
  walk_after: 'Walk afterwards',
  first_date: 'Kind to a first date',
  big_group: 'Takes a crowd',
  rainy_day: 'Fine in the rain',
  special_occasion: 'For an occasion',
  surprise_worked: 'Worked as a surprise',
}

/** Grouped for the rate sheet, so eighteen chips read as three short questions. */
export const TAG_GROUPS: ReadonlyArray<{ heading: string; tags: readonly PlaceTag[] }> = [
  { heading: 'What was it like?', tags: ['quiet', 'lively', 'outdoor', 'view', 'easy_to_talk'] },
  {
    heading: 'Getting in',
    tags: ['book_ahead', 'no_booking_needed', 'late_open', 'step_free', 'dog_ok'],
  },
  {
    heading: 'What is it good for?',
    tags: [
      'great_food',
      'good_value',
      'walk_after',
      'first_date',
      'big_group',
      'rainy_day',
      'special_occasion',
      'surprise_worked',
    ],
  },
]

export const MAX_TAGS_PER_RATING = 6
export const MAX_TIP_LENGTH = 240

/** How many households must have rated a place before anything about it is shown. */
export const ANONYMITY_THRESHOLD = 3

export const COST_BANDS = ['free', 'under_15', 'c15_30', 'c30_60', 'c60_120', 'over_120'] as const

export type CostBand = (typeof COST_BANDS)[number]

/**
 * What a band reads as, **per person**.
 *
 * Per person and never per couple: `Groups.kind` runs from `couple` to `family` and the
 * roster has no maximum, so "for two" would be wrong for most households that will ever see
 * it. Currency is passed in because a household picks its own.
 */
export function costLabel(band: CostBand | null, currency = 'CHF'): string {
  switch (band) {
    case 'free':
      return 'Free'
    case 'under_15':
      return `Under ${currency} 15 each`
    case 'c15_30':
      return `${currency} 15–30 each`
    case 'c30_60':
      return `${currency} 30–60 each`
    case 'c60_120':
      return `${currency} 60–120 each`
    case 'over_120':
      return `${currency} 120+ each`
    default:
      return 'Nobody has said'
  }
}

/** The short form, for a card where the label is competing with everything else. */
export function costShort(band: CostBand | null, currency = 'CHF'): string {
  switch (band) {
    case 'free':
      return 'Free'
    case 'under_15':
      return `< ${currency} 15`
    case 'c15_30':
      return `${currency} 15–30`
    case 'c30_60':
      return `${currency} 30–60`
    case 'c60_120':
      return `${currency} 60–120`
    case 'over_120':
      return `${currency} 120+`
    default:
      return '—'
  }
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

export const KIND_LABEL: Record<PlaceKind, string> = {
  restaurant: 'Restaurant',
  cafe: 'Café',
  bar: 'Bar',
  activity: 'Activity',
  outdoors: 'Outdoors',
  culture: 'Culture',
  shop: 'Shop',
  other: 'Somewhere',
}

/** SAP icon per kind, so a pin and a list row agree about what a place is. */
export const KIND_ICON: Record<PlaceKind, string> = {
  restaurant: 'meal',
  cafe: 'cup',
  bar: 'bar-chart',
  activity: 'physical-activity',
  outdoors: 'tree',
  culture: 'museum',
  shop: 'cart',
  other: 'map',
}

/** The kinds the filter row offers. `other` and `shop` are reachable by search, not by chip. */
export const FILTER_KINDS: readonly PlaceKind[] = [
  'restaurant',
  'cafe',
  'bar',
  'activity',
  'outdoors',
  'culture',
]

/**
 * How far away, said the way a person would.
 *
 * Metres under a kilometre and one decimal above it: "1.2 km" is useful, "1,243 m" is a
 * number to convert in your head while standing in the street.
 */
export function distanceLabel(metres: number | null): string | null {
  if (metres === null || !Number.isFinite(metres)) return null
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`
  return `${(metres / 1000).toFixed(1)} km`
}

/** "12 households", and never "#3 in Zürich" — celebrate, do not rank (ADR-003 §6). */
export function householdsLabel(count: number): string {
  return count === 1 ? '1 household' : `${count} households`
}
