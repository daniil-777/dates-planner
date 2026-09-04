/**
 * The top.
 *
 * A spinning arrow over a ring of sectors, which is how the game this borrows from chooses
 * its question. It decides nothing — the question is drawn in `useGame` before this finishes
 * turning — and it is not decoration either.
 *
 * The second before a question is the best moment in the game. A table stops talking, looks
 * at the table, and waits. Handing that second and a half back instead of cutting straight
 * to the text is most of why people say "again" — anticipation is the cheapest fun in any
 * game and the easiest to leave out.
 *
 * ## How it stops
 *
 * `cubic-bezier(0.15, 0.9, 0.25, 1)` over the same duration the state machine waits: a hard
 * shove and a long settle, the way a real one runs down. A linear spin that stops dead reads
 * as a loading spinner that finished, which is the opposite feeling.
 *
 * The landing angle is random per spin, so the arrow does not come to rest in the same place
 * every time — a top that always stops at twelve o'clock is a top nobody believes.
 */
import { useMemo } from 'react'

/** Sectors, purely visual: enough to read as a wheel, few enough not to be a colour chart. */
const SECTORS = 12

export interface SpinningTopProps {
  spinning: boolean
  /** Changes per round so each spin lands somewhere new. */
  seed: number
}

export function SpinningTop({ spinning, seed }: SpinningTopProps): React.ReactElement {
  // Four full turns plus a random landing, so the travel is long enough to watch and the
  // resting place is never the same twice.
  const angle = useMemo(() => 1440 + ((seed * 137) % 360), [seed])

  return (
    <div className={`chgk-top${spinning ? ' chgk-top--spinning' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 120 120" className="chgk-top__face">
        <circle cx="60" cy="60" r="56" className="chgk-top__rim" />
        {Array.from({ length: SECTORS }, (_unused, index) => {
          const from = (index / SECTORS) * 2 * Math.PI - Math.PI / 2
          const to = ((index + 1) / SECTORS) * 2 * Math.PI - Math.PI / 2
          const point = (radians: number): string =>
            `${60 + 52 * Math.cos(radians)} ${60 + 52 * Math.sin(radians)}`
          return (
            <path
              key={index}
              className={
                index % 2 === 0 ? 'chgk-top__sector' : 'chgk-top__sector chgk-top__sector--alt'
              }
              d={`M 60 60 L ${point(from)} A 52 52 0 0 1 ${point(to)} Z`}
            />
          )
        })}
        <circle cx="60" cy="60" r="20" className="chgk-top__hub" />
      </svg>

      <svg
        viewBox="0 0 120 120"
        className="chgk-top__arrow"
        style={{ transform: spinning ? `rotate(${angle}deg)` : undefined }}
      >
        {/* A needle rather than a pie slice: the arrow is the thing that moves, and a thin
            one reads as motion where a wedge reads as a changing colour. */}
        <path d="M60 14 L66 60 L60 74 L54 60 Z" className="chgk-top__needle" />
        <circle cx="60" cy="60" r="7" className="chgk-top__pivot" />
      </svg>
    </div>
  )
}
