/**
 * Monthly spend forecasting for the pre-spend planner.
 *
 * Pure arithmetic: no I/O, no imports, no clock, no randomness. The same input
 * always produces the same output, including the smoothing parameters — they come
 * from an exhaustive grid search over fixed grids, and ties are broken by grid
 * order, never by a seeded RNG.
 *
 * Method is chosen by how much history exists, because fitting seasonality to one
 * year of data invents a pattern that is not there:
 *
 * | months of history | method                                           |
 * |-------------------|--------------------------------------------------|
 * | >= 24 (2 seasons) | additive Holt-Winters, period 12                 |
 * | 4 … 23            | damped Holt (trend, no season)                   |
 * | 1 … 3             | seasonal naive if a season fits, else last value |
 * | 0                 | nothing — an empty forecast                      |
 *
 * Every exported function is **total**: empty input, a zero horizon or a series
 * full of NaN return sensible empties rather than throwing. A planner card must
 * never take the page down.
 */

export type ForecastMethod =
  'holt-winters' | 'damped-holt' | 'seasonal-naive' | 'last-value' | 'empty'

export interface ForecastOptions {
  /** Observations per season; 12 for monthly totals. */
  seasonLength?: number
  /** Minimum history before seasonality is trusted; defaults to two full seasons. */
  minSeasonalPoints?: number
}

export interface HoltWintersFit {
  method: ForecastMethod
  /** Level smoothing. */
  alpha: number
  /** Trend smoothing; 0 for the non-trending methods. */
  beta: number
  /** Seasonal smoothing; 0 unless the method is `holt-winters`. */
  gamma: number
  /** Trend damping; 1 means undamped. */
  phi: number
  seasonLength: number
  /** Final level and trend of the recursion. */
  level: number
  trend: number
  /** Seasonal offsets indexed by `t % seasonLength`; empty for non-seasonal methods. */
  season: number[]
  /** One-step-ahead in-sample forecasts, aligned with the input series. */
  fitted: number[]
  /** `observation - fitted`, aligned with the input series; 0 inside the warm-up. */
  residuals: number[]
  /** First index that was actually forecast rather than consumed by initialisation. */
  fitFrom: number
  /** Sum of squared errors over `fitFrom …`, the quantity the grid search minimises. */
  sse: number
  /** Residual standard deviation — the width of the prediction band. */
  sigma: number
  /** Point forecast `stepsAhead` months after the last observation (1-based). */
  predict(stepsAhead: number): number
}

export interface ForecastPoint {
  /** Months after the last observation: 1 is next month. */
  index: number
  point: number
  /** 80% band, clamped at 0 — a month cannot be spent backwards. */
  lo: number
  hi: number
}

export interface TripPlanInput {
  targetAmount: number
  monthsUntil: number
  /** What the household normally spends in a month. */
  avgMonthlyTotal: number
  /** What the forecast says it will spend in a month. */
  forecastMonthlyTotal: number
  /**
   * How many people are putting the money aside. The household has no fixed size
   * (CONTRACTS.md §10), so this is an input rather than a constant; one person is the
   * safe default, and the per-person figure is then the whole instalment.
   */
  people?: number
  /** Currency for the verdict text; CONTRACTS §1.4 defaults to CHF. */
  currency?: string
}

export interface TripPlan {
  requiredMonthly: number
  freeCashMonthly: number
  feasible: boolean
  /** One warm sentence a human can act on. */
  verdict: string
  /** `requiredMonthly` divided over the people saving. Context, never a claim on anybody. */
  perPersonMonthly: number
}

/** z for a two-sided 80% interval. */
const Z_80 = 1.2816

const DEFAULT_SEASON_LENGTH = 12
const DEFAULT_MIN_SEASONAL_POINTS = 24
const MIN_TREND_POINTS = 4

// Coarse but sufficient: monthly household spend has a handful of observations, so a
// finer grid would only overfit. Grids are ordered so the first minimum wins, which
// prefers the smoother (smaller) parameter on a tie.
const ALPHA_GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
const BETA_GRID = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]
const GAMMA_GRID = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]
const PHI_GRID = [0.8, 0.85, 0.9, 0.95, 0.98, 1]

/**
 * Round to 2 decimals, half-up, tolerating garbage.
 *
 * WHY not `srv/lib/money.ts`: that module throws on non-finite input by design,
 * and this one is contractually total. The forecaster keeps its own tiny copy so a
 * degenerate series can never turn a planner card into a 500.
 */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  // Shift through the decimal string rather than multiplying by 100, so 1.005
  // rounds to 1.01 instead of falling foul of its own binary representation.
  const shift = (input: number, places: number): number => {
    const parts = input.toString().split('e')
    const exponent = parts.length > 1 ? Number(parts[1]) : 0
    return Number(`${parts[0]}e${exponent + places}`)
  }
  const scaled = shift(value, 2)
  const cents = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return cents === 0 ? 0 : shift(cents, -2)
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

/** NaN, null and undefined become 0 so one bad month cannot poison the whole fit. */
function sanitise(series: readonly number[]): number[] {
  if (!Array.isArray(series)) return []
  return series.map(value => (Number.isFinite(value) ? Number(value) : 0))
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

interface Recursion {
  level: number
  trend: number
  season: number[]
  fitted: number[]
  sse: number
  fitFrom: number
}

interface SeasonalInit {
  level: number
  trend: number
  season: number[]
}

/**
 * Deterministic Holt-Winters initialisation by classical additive decomposition.
 *
 * The trend is the average drift per month between the first and last whole
 * season. Seasonal offsets are then the average deviation of each month from that
 * **trend line**, re-centred to sum to zero.
 *
 * WHY not the textbook shortcut of "deviation from the season's own mean": that
 * measures each month against the middle of its year, so half the annual trend
 * (±b·(m-1)/2 — a full CHF 44/month on a CHF 8/month drift) leaks into the
 * seasonal indices, tilting January down and December up. The seasonal smoothing
 * only ever revisits a given month once a year, so that tilt survives the whole
 * fit and biases every multi-step forecast.
 *
 * `level` is the state at t = m-1, i.e. the deseasonalised value of the last
 * observation the initialisation consumed, because the recursion below starts by
 * forecasting t = m from it.
 */
function seasonalInit(y: readonly number[], m: number): SeasonalInit {
  const seasons = Math.floor(y.length / m)
  const seasonMeans: number[] = []
  for (let k = 0; k < seasons; k += 1) {
    seasonMeans.push(mean(y.slice(k * m, k * m + m)))
  }

  const trend = seasons > 1 ? (seasonMeans[seasons - 1] - seasonMeans[0]) / (m * (seasons - 1)) : 0
  // A season mean sits at the middle of its season, so the intercept at t = 0 is
  // that mean walked back by half a season.
  const intercept = seasonMeans[0] - (trend * (m - 1)) / 2

  const season: number[] = []
  for (let phase = 0; phase < m; phase += 1) {
    const deviations: number[] = []
    for (let k = 0; k < seasons; k += 1) {
      const t = k * m + phase
      deviations.push(y[t] - (intercept + trend * t))
    }
    season.push(mean(deviations))
  }
  const centre = mean(season)
  return {
    level: intercept + trend * (m - 1),
    trend,
    season: season.map(value => value - centre),
  }
}

/** Additive Holt-Winters recursion; `season[t % m]` always holds the estimate for `s_{t-m}`. */
function runHoltWinters(
  y: readonly number[],
  m: number,
  init: SeasonalInit,
  alpha: number,
  beta: number,
  gamma: number,
): Recursion {
  let level = init.level
  let trend = init.trend
  const season = init.season.slice()
  const fitted = y.slice()
  let sse = 0

  for (let t = m; t < y.length; t += 1) {
    const phase = t % m
    const previousSeason = season[phase]
    const point = level + trend + previousSeason
    fitted[t] = point
    const error = y[t] - point
    sse += error * error

    const nextLevel = alpha * (y[t] - previousSeason) + (1 - alpha) * (level + trend)
    const nextTrend = beta * (nextLevel - level) + (1 - beta) * trend
    season[phase] = gamma * (y[t] - nextLevel) + (1 - gamma) * previousSeason
    level = nextLevel
    trend = nextTrend
  }

  return { level, trend, season, fitted, sse, fitFrom: m }
}

/** Holt's linear trend with damping factor `phi`; `phi === 1` is plain Holt. */
function runDampedHolt(y: readonly number[], alpha: number, beta: number, phi: number): Recursion {
  let level = y[0]
  let trend = y[1] - y[0]
  const fitted = y.slice()
  let sse = 0

  for (let t = 1; t < y.length; t += 1) {
    const point = level + phi * trend
    fitted[t] = point
    const error = y[t] - point
    sse += error * error

    const nextLevel = alpha * y[t] + (1 - alpha) * point
    const nextTrend = beta * (nextLevel - level) + (1 - beta) * phi * trend
    level = nextLevel
    trend = nextTrend
  }

  return { level, trend, season: [], fitted, sse, fitFrom: 1 }
}

/** Last season repeated: `ŷ_t = y_{t-m}`. */
function runSeasonalNaive(y: readonly number[], m: number): Recursion {
  const fitted = y.slice()
  let sse = 0
  for (let t = m; t < y.length; t += 1) {
    fitted[t] = y[t - m]
    const error = y[t] - fitted[t]
    sse += error * error
  }
  return { level: y[y.length - 1], trend: 0, season: [], fitted, sse, fitFrom: m }
}

/** Flat line at the last observation — the honest answer when there is no history. */
function runLastValue(y: readonly number[]): Recursion {
  const fitted = y.slice()
  let sse = 0
  for (let t = 1; t < y.length; t += 1) {
    fitted[t] = y[t - 1]
    const error = y[t] - fitted[t]
    sse += error * error
  }
  return { level: y[y.length - 1], trend: 0, season: [], fitted, sse, fitFrom: 1 }
}

interface Candidate {
  run: Recursion
  alpha: number
  beta: number
  gamma: number
  phi: number
}

/** Keeps the strictly-best SSE, so the first grid point wins a tie (determinism). */
function better(candidate: Candidate, best: Candidate | null): boolean {
  if (!Number.isFinite(candidate.run.sse)) return false
  return best === null || candidate.run.sse < best.run.sse
}

function searchHoltWinters(y: readonly number[], m: number): Candidate | null {
  const init = seasonalInit(y, m)
  let best: Candidate | null = null
  for (const alpha of ALPHA_GRID) {
    for (const beta of BETA_GRID) {
      for (const gamma of GAMMA_GRID) {
        const candidate: Candidate = {
          run: runHoltWinters(y, m, init, alpha, beta, gamma),
          alpha,
          beta,
          gamma,
          phi: 1,
        }
        if (better(candidate, best)) best = candidate
      }
    }
  }
  return best
}

function searchDampedHolt(y: readonly number[]): Candidate | null {
  let best: Candidate | null = null
  for (const alpha of ALPHA_GRID) {
    for (const beta of BETA_GRID) {
      for (const phi of PHI_GRID) {
        const candidate: Candidate = {
          run: runDampedHolt(y, alpha, beta, phi),
          alpha,
          beta,
          gamma: 0,
          phi,
        }
        if (better(candidate, best)) best = candidate
      }
    }
  }
  return best
}

/**
 * Residual standard deviation over the fitted window.
 *
 * Uses `n - 1` (the sample estimator) and returns 0 for a single residual, which
 * collapses the band to the point forecast instead of producing NaN.
 */
function residualSigma(sse: number, count: number): number {
  if (count < 2 || !Number.isFinite(sse) || sse <= 0) return 0
  return Math.sqrt(sse / (count - 1))
}

function buildFit(
  method: ForecastMethod,
  y: readonly number[],
  m: number,
  candidate: Candidate,
  predict: (stepsAhead: number) => number,
): HoltWintersFit {
  const { run, alpha, beta, gamma, phi } = candidate
  const residuals = y.map((value, index) => (index < run.fitFrom ? 0 : value - run.fitted[index]))
  const sigma = residualSigma(run.sse, y.length - run.fitFrom)

  return {
    method,
    alpha,
    beta,
    gamma,
    phi,
    seasonLength: m,
    level: finite(run.level),
    trend: finite(run.trend),
    season: run.season.map(value => finite(value)),
    fitted: run.fitted.map(value => finite(value)),
    residuals: residuals.map(value => finite(value)),
    fitFrom: run.fitFrom,
    sse: finite(run.sse),
    sigma,
    predict: stepsAhead => finite(predict(Math.max(1, Math.trunc(finite(stepsAhead, 1))))),
  }
}

function emptyFit(m: number): HoltWintersFit {
  return {
    method: 'empty',
    alpha: 0,
    beta: 0,
    gamma: 0,
    phi: 1,
    seasonLength: m,
    level: 0,
    trend: 0,
    season: [],
    fitted: [],
    residuals: [],
    fitFrom: 0,
    sse: 0,
    sigma: 0,
    predict: () => 0,
  }
}

/**
 * Fit the best model the history supports and return it with a `predict` closure.
 *
 * The returned point forecasts are the raw model output and may be negative for a
 * steeply falling series; `forecast()` is the function that clamps them, because
 * only there do we know we are looking at spend totals.
 */
export function holtWinters(series: readonly number[], opts: ForecastOptions = {}): HoltWintersFit {
  const y = sanitise(series)
  const n = y.length
  const requested = Math.trunc(
    finite(opts.seasonLength ?? DEFAULT_SEASON_LENGTH, DEFAULT_SEASON_LENGTH),
  )
  const m = requested >= 2 ? requested : DEFAULT_SEASON_LENGTH
  const minSeasonal = Math.max(
    2 * m,
    Math.trunc(
      finite(opts.minSeasonalPoints ?? DEFAULT_MIN_SEASONAL_POINTS, DEFAULT_MIN_SEASONAL_POINTS),
    ),
  )

  if (n === 0) return emptyFit(m)

  if (n >= minSeasonal) {
    const best = searchHoltWinters(y, m)
    if (best !== null) {
      const { level, trend, season } = best.run
      // Seasonal offsets are indexed by phase, so month `n - 1 + h` reuses the
      // estimate last updated one full season ago.
      return buildFit('holt-winters', y, m, best, h => level + h * trend + season[(n - 1 + h) % m])
    }
  }

  if (n >= MIN_TREND_POINTS) {
    const best = searchDampedHolt(y)
    if (best !== null) {
      const { level, trend } = best.run
      const phi = best.phi
      return buildFit('damped-holt', y, m, best, h => {
        // Damped trend: the horizon contributes phi + phi^2 + … + phi^h, which
        // converges instead of extrapolating a straight line to the moon.
        let damping = 0
        let power = 1
        for (let step = 1; step <= h; step += 1) {
          power *= phi
          damping += power
        }
        return level + trend * damping
      })
    }
  }

  if (n >= m) {
    const run = runSeasonalNaive(y, m)
    const candidate: Candidate = { run, alpha: 0, beta: 0, gamma: 0, phi: 1 }
    return buildFit('seasonal-naive', y, m, candidate, h => y[n - m + ((h - 1) % m)])
  }

  const run = runLastValue(y)
  const candidate: Candidate = { run, alpha: 0, beta: 0, gamma: 0, phi: 1 }
  const last = y[n - 1]
  return buildFit('last-value', y, m, candidate, () => last)
}

/**
 * Point forecasts with an 80% band for the next `monthsAhead` months.
 *
 * The band is `±1.2816 σ` of the in-sample residuals and deliberately does **not**
 * widen with the horizon: it is a "roughly this much" hint on a planner card, not
 * an inferential interval, and a fan that doubles by month six reads as noise.
 * `lo` is clamped at 0 and `point`/`hi` can never be NaN — these are spend totals
 * shown to a household, not model diagnostics.
 */
export function forecast(
  series: readonly number[],
  monthsAhead: number,
  opts: ForecastOptions = {},
): ForecastPoint[] {
  const horizon = Math.max(0, Math.trunc(finite(monthsAhead)))
  if (horizon === 0) return []

  const fit = holtWinters(series, opts)
  if (fit.method === 'empty') return []

  const band = Z_80 * fit.sigma
  const points: ForecastPoint[] = []
  for (let step = 1; step <= horizon; step += 1) {
    const point = Math.max(0, round2(fit.predict(step)))
    points.push({
      index: step,
      point,
      lo: Math.max(0, round2(point - band)),
      hi: round2(point + band),
    })
  }
  return points
}

/** `CHF 1234.50` — plain and unambiguous; the UI can prettify. */
function formatMoney(value: number, currency: string): string {
  return `${currency} ${round2(Math.abs(value)).toFixed(2)}`
}

/**
 * "Lisbon in October?" — can we put the money aside in time?
 *
 * `freeCashMonthly` is what the brief calls free cash: the gap between what the
 * household normally spends (`avgMonthlyTotal`) and what it is forecast to spend
 * (`forecastMonthlyTotal`). A cheaper-than-usual few months is money that can go to
 * the trip instead; a forecast above the average means there is nothing spare.
 *
 * Total by construction: a non-positive horizon collapses to "this month", a
 * non-positive target is already paid for, and no input can make it throw.
 */
export function planTrip(input: TripPlanInput): TripPlan {
  const currency =
    typeof input.currency === 'string' && input.currency !== '' ? input.currency : 'CHF'
  const target = Math.max(0, round2(finite(input.targetAmount)))
  // Whole months only — you cannot set money aside in half a month.
  const months = Math.max(1, Math.round(finite(input.monthsUntil, 1)))
  const freeCashMonthly = round2(finite(input.avgMonthlyTotal) - finite(input.forecastMonthlyTotal))
  const requiredMonthly = round2(target / months)
  // At least one: a plan nobody is saving for is still one person's plan.
  const savers = Math.max(1, Math.round(finite(input.people ?? 1, 1)))
  const perPersonMonthly = round2(requiredMonthly / savers)
  const feasible = target === 0 || freeCashMonthly >= requiredMonthly

  const required = formatMoney(requiredMonthly, currency)
  const perPerson = formatMoney(perPersonMonthly, currency)
  const free = formatMoney(freeCashMonthly, currency)
  const monthWord = months === 1 ? 'month' : 'months'

  let verdict: string
  if (target === 0) {
    verdict = 'Nothing to put aside — that one is already paid for. Go and enjoy it.'
  } else if (freeCashMonthly <= 0) {
    verdict =
      `Not on the current pattern: the forecast already spends everything you normally do, ` +
      `so there is no free cash to move. Push the date out, or find ${required} a month elsewhere.`
  } else if (!feasible) {
    const shortfall = formatMoney(requiredMonthly - freeCashMonthly, currency)
    const monthsNeeded = Math.ceil(target / freeCashMonthly)
    verdict =
      `Close. It needs ${required} a month and about ${free} looks free — ${shortfall} short. ` +
      `Give it ${monthsNeeded} months instead, or trim ${shortfall} a month somewhere.`
  } else if (freeCashMonthly >= requiredMonthly * 1.25) {
    const slack = formatMoney(freeCashMonthly - requiredMonthly, currency)
    verdict =
      `Yes. Set aside ${required} a month — ${perPerson} each — and it is covered in ` +
      `${months} ${monthWord}, with roughly ${slack} a month still spare. Book it.`
  } else {
    verdict =
      `Doable, but snug: ${required} a month (${perPerson} each) against ${free} of room. ` +
      `One generous month and it wobbles, so start putting it aside this week.`
  }

  return { requiredMonthly, freeCashMonthly, feasible, verdict, perPersonMonthly }
}
