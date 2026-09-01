/*
 * The three seconds after you sign in.
 *
 * A burst of hearts and stars, a line of welcome, and then it is gone and the app is
 * underneath exactly as it was. Three rules make that true rather than approximately true:
 *
 *  1. **It never takes the pointer.** The overlay is `pointer-events: none` all the way
 *     down, so a tap that lands during the animation reaches the app, not the confetti.
 *  2. **It unmounts.** `onDone` fires once, on a timer that is cleared if the component
 *     leaves early, and `AuthGate` drops it from the tree. Nothing is left animating
 *     off-screen, and nothing keeps a compositor layer alive for the rest of the session.
 *  3. **It is skippable.** Under `prefers-reduced-motion` the particles are not rendered at
 *     all — the greeting still appears, still for three seconds, and simply holds still.
 *     Vestibular disorders are not a reason to miss the sentence.
 *
 * Only a *fresh* sign-in gets this. Reloading the page finds an existing session and goes
 * straight to the app; a firework on every reload would be a nuisance within a day.
 */
import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement } from 'react'
import './welcomeFireworks.css'

/** Total run time. Matches the longest CSS animation; see `welcomeFireworks.css`. */
const DURATION_MS = 3000

/**
 * Where the bursts go off, in percentages of the viewport, and how late each one is.
 *
 * Hand-placed rather than random: they are spread around the greeting without ever sitting
 * on top of it, and the stagger reads as a sequence of pops instead of one flat bang.
 */
const BURSTS = [
  { x: 18, y: 30, delay: 0 },
  { x: 82, y: 26, delay: 0.18 },
  { x: 50, y: 14, delay: 0.36 },
  { x: 28, y: 66, delay: 0.54 },
  { x: 74, y: 62, delay: 0.72 },
  { x: 50, y: 78, delay: 0.9 },
] as const

/** Particles per burst. Six bursts × fourteen is enough to read as a shower, cheap enough
 *  that a mid-range phone still composites it at 60fps. */
const PER_BURST = 14

/** SAP Horizon blue and magenta, plus the warm end a firework wants. */
const HUES = [211, 320, 275, 42, 350, 190] as const

interface Particle {
  id: string
  kind: 'heart' | 'star'
  style: CSSProperties
}

/**
 * One burst's worth of particles, fanned evenly and then jittered.
 *
 * Even spacing keeps a burst from clumping on one side; the jitter keeps six bursts from
 * looking like six copies of the same wheel. Distance and scale vary per particle so the
 * shower has depth rather than reading as a single expanding ring.
 */
function makeBurst(burstIndex: number, originX: number, originY: number, delay: number): Particle[] {
  return Array.from({ length: PER_BURST }, (_, i) => {
    const angle = (i / PER_BURST) * Math.PI * 2 + Math.random() * 0.45
    const distance = 90 + Math.random() * 130
    const dx = Math.cos(angle) * distance
    // Biased downward at the end of the flight, so the shower falls the way sparks do
    // instead of hanging in a perfect circle.
    const dy = Math.sin(angle) * distance + 40 + Math.random() * 60

    const style = {
      left: `${originX}%`,
      top: `${originY}%`,
      '--dx': `${dx.toFixed(1)}px`,
      '--dy': `${dy.toFixed(1)}px`,
      '--scale': (0.55 + Math.random() * 0.85).toFixed(2),
      '--rot': `${(Math.random() * 900 - 450).toFixed(0)}deg`,
      '--hue': `${HUES[(burstIndex + i) % HUES.length]}`,
      '--delay': `${(delay + Math.random() * 0.12).toFixed(2)}s`,
      '--spin': `${(0.9 + Math.random() * 0.5).toFixed(2)}s`,
    } as CSSProperties

    return { id: `b${burstIndex}-p${i}`, kind: i % 2 === 0 ? 'heart' : 'star', style }
  })
}

function Heart(): ReactElement {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 28S3 19.6 3 11.6A7.6 7.6 0 0 1 16 6.9 7.6 7.6 0 0 1 29 11.6C29 19.6 16 28 16 28Z" />
    </svg>
  )
}

function Star(): ReactElement {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 2.5 20 12l10.2.8-7.8 6.6 2.4 10L16 23.9 7.2 29.4l2.4-10L1.8 12.8 12 12Z" />
    </svg>
  )
}

export interface WelcomeFireworksProps {
  /** Called once, after {@link DURATION_MS}, so the parent can unmount this. */
  onDone: () => void
}

export function WelcomeFireworks({ onDone }: WelcomeFireworksProps): ReactElement {
  // Media query read once, at mount: the animation is three seconds long and a preference
  // flipped mid-flight is not worth a re-render.
  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // Randomised once per mount rather than per render, so React re-rendering the tree
  // underneath does not teleport every particle mid-flight.
  const particles = useMemo(
    () =>
      reduced ? [] : BURSTS.flatMap((burst, index) => makeBurst(index, burst.x, burst.y, burst.delay)),
    [reduced],
  )

  // The parent passes an inline arrow, so `onDone` has a new identity on every one of its
  // renders. Read it through a ref: the timer is armed once per mount and a re-render
  // underneath cannot push the three seconds out — rule 2 above depends on that.
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const timer = window.setTimeout(() => done.current(), DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="twm-fw" role="status" aria-live="polite">
      <div className="twm-fw__wash" />

      {BURSTS.map((burst, index) =>
        reduced ? null : (
          <span
            key={`ring-${index}`}
            className="twm-fw__ring"
            style={
              {
                left: `${burst.x}%`,
                top: `${burst.y}%`,
                '--delay': `${burst.delay}s`,
                '--hue': `${HUES[index % HUES.length]}`,
              } as CSSProperties
            }
          />
        ),
      )}

      {particles.map(particle => (
        <span key={particle.id} className={`twm-fw__p twm-fw__p--${particle.kind}`} style={particle.style}>
          {particle.kind === 'heart' ? <Heart /> : <Star />}
        </span>
      ))}

      <div className="twm-fw__card">
        <p className="twm-fw__hello">Welcome!</p>
        <p className="twm-fw__line">Plan your dates, enjoy your life, relax!</p>
      </div>
    </div>
  )
}

export default WelcomeFireworks
