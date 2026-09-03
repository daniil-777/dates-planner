/**
 * How a place is scored — CONTRACTS.md §14.3.
 *
 * Pure arithmetic: no I/O, no clock, no randomness, and every function is total, so a place
 * with no ratings returns zero rather than `NaN`.
 *
 * ## Why the displayed number and the ordering number are different
 *
 * Stars are what people give and what they read, so the mean is shown. The mean is a bad
 * *ordering*, and obviously so once there is any real data in the corpus: one household
 * gives a place five stars, and it now sits above forty households' 4.6. Every ranking built
 * on a raw mean spends its first year with the top of the list occupied by places nobody has
 * been to.
 *
 * The fix is the standard one — shrink the mean toward the global mean in proportion to how
 * little evidence there is:
 *
 *     score = (v·R + m·C) / (v + m)
 *
 * `v` ratings with mean `R`, a global mean `C` over the whole corpus, and a prior weight `m`
 * that says how many ratings' worth of evidence it takes to move a place off the global
 * average. It is one line, it needs no tuning to be right, and it is the difference between
 * a ranking that is useful in month one and one that is noise.
 */
import { ANONYMITY_THRESHOLD } from './vocabulary'

/**
 * How much evidence the prior is worth, in ratings.
 *
 * Eight, chosen against the anonymity threshold rather than by taste: a place becomes
 * visible at three ratings, and at three the prior should still be doing most of the work
 * (3/11 of the way to its own mean), while forty ratings should be almost entirely its own
 * (40/48). A larger `m` flattens the ranking; a smaller one lets a handful of ratings
 * dominate, which is exactly what this is here to prevent.
 */
export const PRIOR_WEIGHT = 8

/**
 * The global mean to fall back on before the corpus has one.
 *
 * 3.9 rather than 3.0. Ratings on a five-star scale are famously not centred — people rate
 * places they chose to go to, so the observed mean everywhere is somewhere near four — and a
 * prior of 3.0 would punish every new place for being new.
 */
export const DEFAULT_GLOBAL_MEAN = 3.9

export interface Histogram {
  readonly s1: number
  readonly s2: number
  readonly s3: number
  readonly s4: number
  readonly s5: number
}

export const EMPTY_HISTOGRAM: Histogram = { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 }

/** The five-bucket histogram as a count and a sum of stars. */
export function totals(histogram: Histogram): { count: number; sum: number } {
  const count = histogram.s1 + histogram.s2 + histogram.s3 + histogram.s4 + histogram.s5
  const sum =
    histogram.s1 + histogram.s2 * 2 + histogram.s3 * 3 + histogram.s4 * 4 + histogram.s5 * 5
  return { count, sum }
}

/** Adds or removes one star from a histogram. `delta` is +1 for a rating, −1 to withdraw it. */
export function applyStar(histogram: Histogram, stars: number, delta: 1 | -1): Histogram {
  const bucket = `s${Math.min(5, Math.max(1, Math.round(stars)))}` as keyof Histogram
  const next = { ...histogram, [bucket]: Math.max(0, histogram[bucket] + delta) }
  return next
}

/** The plain mean, to two decimals. Zero when nobody has rated it. */
export function mean(sum: number, count: number): number {
  if (count <= 0) return 0
  return Math.round((sum / count) * 100) / 100
}

/**
 * The ranking score: the mean shrunk toward `globalMean`.
 *
 * Rounded to four decimals so it is stable across engines — the value is written to a
 * `Decimal(6,4)` column and two rows that tie must tie identically on every store, or
 * keyset pagination can skip or repeat a row at a page boundary.
 */
export function bayesianScore(
  sum: number,
  count: number,
  globalMean: number = DEFAULT_GLOBAL_MEAN,
  priorWeight: number = PRIOR_WEIGHT,
): number {
  if (count <= 0) return Math.round(globalMean * 10000) / 10000
  const score = (sum + priorWeight * globalMean) / (count + priorWeight)
  return Math.round(score * 10000) / 10000
}

/**
 * Whether a place has enough independent households behind it to be shown at all.
 *
 * The single most important predicate in the commons, and it is deliberately a function
 * rather than an inlined `>= 3` at each call site: there are four places that must agree
 * about it — the list, the place page, the tips and the card deck — and they must not drift.
 */
export function isPublishable(ratings: number): boolean {
  return ratings >= ANONYMITY_THRESHOLD
}

/** How many more households have to rate a place before it appears. Zero once it has. */
export function ratingsUntilPublishable(ratings: number): number {
  return Math.max(0, ANONYMITY_THRESHOLD - ratings)
}
