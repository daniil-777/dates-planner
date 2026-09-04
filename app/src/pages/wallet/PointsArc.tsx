/**
 * The points figure, as a ring.
 *
 * ## Why a ring rather than a bar
 *
 * A progress bar answers "how far along am I", which is the wrong question here: there is no
 * end to reach. A ring reads as a *standing* — a thing you are currently at, which happens to
 * be filling — and that is what the number actually is. The same reason watch faces and
 * activity rings are rings.
 *
 * The number in the middle is the balance and it is the largest thing on the screen, because
 * it is the only figure anybody came to see. The standing is underneath in words rather than
 * as a level number: "Worth listening to" tells somebody what they have become, and "level 4"
 * tells them nothing at all.
 *
 * ## Two details that decide whether it looks expensive or cheap
 *
 * **A ring at zero must not be an empty grey circle.** That is what a flat `stroke-dashoffset`
 * of the full circumference gives you, and it reads as *broken* rather than as *starting* —
 * the one impression a brand-new household must not get on their first visit. So the fill
 * never drops below a short cap's worth of arc: enough to say "this is the beginning of
 * something", not enough to claim progress that has not happened.
 *
 * **The stroke is a gradient, not a colour.** A single flat hue around a 172-pixel ring looks
 * like a loading spinner. Two stops travelling from the app's blue into a warmer indigo give
 * it depth for the cost of four lines of SVG, and it is the difference between a control and
 * an ornament.
 *
 * ## The count
 *
 * The number counts up on first paint rather than appearing. It takes 900 ms, it is driven by
 * `requestAnimationFrame` against a clock rather than a fixed step count (so it takes the
 * same time on every device), and it eases out — a linear count looks mechanical and an
 * ease-out looks like something settling. It is skipped entirely under
 * `prefers-reduced-motion`, where a number that will not sit still is genuinely unpleasant.
 */
import { useEffect, useRef, useState } from 'react'

export interface PointsArcProps {
  points: number
  standing: string
  /** Points at the next rung, or null when there is no higher one. */
  next: number | null
  /** How far into the current rung, 0–1. */
  into: number
}

const SIZE = 176
const STROKE = 13
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** A ring at zero shows this much, so "just started" does not look like "broken". */
const MINIMUM_ARC = 0.012

const COUNT_MS = 900

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Counts to `target` once, easing out. Returns `target` immediately when motion is off. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? target : 0))
  const done = useRef(false)

  useEffect(() => {
    if (done.current || prefersReducedMotion() || target === 0) {
      setShown(target)
      done.current = true
      return
    }
    done.current = true

    let frame = 0
    const started = performance.now()
    const step = (now: number): void => {
      const through = Math.min(1, (now - started) / COUNT_MS)
      // Cubic ease-out: fast, then settling. A linear count looks like a machine.
      const eased = 1 - Math.pow(1 - through, 3)
      setShown(Math.round(target * eased))
      if (through < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target])

  return shown
}

export function PointsArc({ points, standing, next, into }: PointsArcProps): React.ReactElement {
  // A full ring at the top rung: there is nothing left to fill, and showing it 3% full
  // because the arithmetic ran out would read as a demotion.
  const proportion = next === null ? 1 : Math.min(1, Math.max(0, into))
  const filled = Math.max(MINIMUM_ARC, proportion)
  const shown = useCountUp(points)

  return (
    <figure className="arc">
      <svg
        className="arc__svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        aria-hidden="true"
      >
        <defs>
          {/* Two stops rather than one colour. A flat hue around a ring this size reads as
              a loading spinner; a gradient reads as a dial. */}
          <linearGradient id="arc-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--arc-from)" />
            <stop offset="100%" stopColor="var(--arc-to)" />
          </linearGradient>
        </defs>

        <circle
          className="arc__track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
        />
        <circle
          className="arc__fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          stroke="url(#arc-stroke)"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
        />
      </svg>

      <figcaption className="arc__inside">
        <span className="arc__points">{shown.toLocaleString('en-CH')}</span>
        <span className="arc__unit">points</span>
      </figcaption>

      <p className="arc__standing">
        <span className="arc__standingName">{standing}</span>
        {next !== null && (
          <span className="arc__toGo">{(next - points).toLocaleString('en-CH')} to the next</span>
        )}
      </p>
    </figure>
  )
}
