/**
 * The cross-cutting values from CONTRACTS.md §1.1, §1.2 and §1.4.
 *
 * This module is the TypeScript half of a contract whose other half lives in
 * Python (`ml/generate_data.py`, `ml/train.py`), in CDS (`db/schema.cds`,
 * `db/data/twowaymatch-Categories.csv`) and in the React app. It therefore holds
 * *only* values that all of those sides have to agree on, has no imports, and
 * has no behaviour: anything with logic in it would eventually diverge from the
 * Python side, which is exactly what this file exists to prevent.
 *
 * Category display metadata (name, icon, colour, sort order) deliberately does
 * **not** live here — CONTRACTS.md §1.1 puts it in the seeded code list so it
 * stays editable at runtime. What is fixed is the ASCII `code`, because it is
 * the literal string the classifier was trained on.
 */

/**
 * Below this winning probability a prediction is shown to the human for review
 * (CONTRACTS.md §1.4). Compared against `categoryConfidence` / `momentConfidence`,
 * which are the probability of the *winning* label, not a margin.
 */
export const NEEDS_REVIEW_THRESHOLD = 0.6

/** ISO-4217 code every amount defaults to (CONTRACTS.md §1.4). */
export const DEFAULT_CURRENCY = 'CHF'

/**
 * The ten category codes, in the order CONTRACTS.md §1.1 lists them.
 *
 * The order is part of the contract — it is the order the frontend renders chips
 * in — and is deliberately *not* alphabetical, so it must not be re-sorted here.
 * `as const` makes this a readonly tuple of string literals, which is what lets a
 * consumer derive a union type (`(typeof CATEGORY_CODES)[number]`) instead of
 * repeating the ten strings a fourth time.
 *
 * Note that the classifier's own label order is different: `weights.json` sorts
 * its labels ascending because that is the order scikit-learn assigns row
 * indices in. Never use one list to index into the other.
 */
export const CATEGORY_CODES = [
  'Groceries',
  'Dining',
  'Cafes',
  'Transport',
  'Travel',
  'Gifts',
  'Home',
  'Health',
  'Entertainment',
  'Subscriptions',
] as const

/**
 * The four moment codes, in the order CONTRACTS.md §1.2 lists them.
 *
 * Same string values as the `MomentCode` enum in `db/schema.cds`; this array
 * exists because an enum in CDS gives no iteration order to the runtime.
 */
export const MOMENT_CODES = ['everyday', 'date_night', 'trip', 'gift'] as const

/**
 * The nineteen touch-map regions — CONTRACTS.md §13.1.
 *
 * Kept here beside the category and moment codes because it is the same kind of thing: a
 * closed vocabulary shared across a boundary, where one side inventing a value the other
 * has never heard of is the failure to prevent. `app/src/pages/intimacy/zones.ts` is the
 * client's copy, and the two lists must not diverge.
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
