/**
 * The minute.
 *
 * ## Why it is a ring and not a bar
 *
 * A ring closing on itself is the one countdown shape people read without converting: at a
 * glance you see *how much is left* rather than *how much has gone*, and the difference
 * matters when six people are arguing and one of them looks up for a quarter of a second.
 * A bar has to be read left to right and compared against its own length; a ring is a
 * quantity.
 *
 * ## Drawn, not animated by CSS
 *
 * The arc is `stroke-dasharray` driven straight from the seconds left. A CSS transition
 * would be smoother and would also be *lying*: if the tab is backgrounded and comes back,
 * the transition eases from where it was to where it should be, showing a second and a half
 * of time that has already gone. The clock is read from a deadline (`useGame`), so this
 * draws what is true and jumps if the truth jumped.
 *
 * ## The last ten seconds
 *
 * They change colour and the number gets a pulse. Not for drama — because that is when a
 * table stops discussing and starts choosing, and the signal is what tells them to.
 */
import { DISCUSSION_SECONDS, URGENT_SECONDS } from './types'

/** A viewBox unit circle; the ring is drawn in these and scaled by CSS. */
const SIZE = 120
const STROKE = 8
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface TimerProps {
  /** Seconds remaining. */
  left: number
  /** Dimmed and still, before the minute starts. */
  idle?: boolean
}

export function Timer({ left, idle = false }: TimerProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(DISCUSSION_SECONDS, left))
  const remaining = clamped / DISCUSSION_SECONDS
  const urgent = !idle && clamped <= URGENT_SECONDS && clamped > 0
  const done = !idle && clamped === 0

  const classes = ['chgk-timer']
  if (idle) classes.push('chgk-timer--idle')
  if (urgent) classes.push('chgk-timer--urgent')
  if (done) classes.push('chgk-timer--done')

  return (
    <div
      className={classes.join(' ')}
      role="timer"
      aria-live={urgent ? 'assertive' : 'off'}
      aria-label={`${clamped} seconds left`}
    >
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="chgk-timer__ring" aria-hidden="true">
        <circle
          className="chgk-timer__track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
        />
        <circle
          className="chgk-timer__arc"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          // Starts at twelve o'clock and unwinds clockwise, like every clock face.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - remaining)}
        />
      </svg>
      <span className="chgk-timer__value">{clamped}</span>
      <span className="chgk-timer__unit">{done ? 'time' : 'seconds'}</span>
    </div>
  )
}
