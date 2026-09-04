/**
 * A lamp you can press for hints.
 *
 * ## What it is for, and the line it must not cross
 *
 * The evidence on in-app help is consistent and slightly uncomfortable: linear onboarding
 * that shows everything up front completes about half the time, while help surfaced *at the
 * moment it is wanted* completes far more often. The usable rule out of that is not "hide the
 * explanation behind a button" — it is **make the existence of help visible, and keep the
 * detail until somebody asks**.
 *
 * So this component has a hard rule about what may go in it: **never the instruction.** What
 * a screen is asking you to do belongs on the screen, in plain sight, where somebody who
 * never presses anything will read it. A lamp holding the essential explanation is not
 * progressive disclosure, it is a hidden explanation with a nicer icon — and a hint nobody
 * presses is a hint nobody has.
 *
 * What belongs in here is the second layer: the things people *wonder* rather than the things
 * they must know. Who else can see this. Whether it matters that I have not finished. Whether
 * I can change my mind. Questions that would clutter the screen if answered inline and would
 * nag if left unanswered.
 *
 * ## Why it glows once
 *
 * An affordance nobody notices is the commonest failure of this pattern — it becomes
 * decoration, and then a dumping ground for copy nobody could place elsewhere. On a screen
 * somebody has not seen before it pulses gently a few times and then stops for good, which is
 * the smallest thing that makes its existence visible without demanding anything. It is
 * remembered per screen in `localStorage`, so it is not a nag.
 *
 * ## Accessibility
 *
 * A real `<button>` with `aria-expanded`, controlling a region that follows it in the DOM, so
 * a screen reader meets the hints immediately after the control that opened them and a
 * keyboard reaches them by pressing Tab once. The glow is decorative and is removed entirely
 * under `prefers-reduced-motion`; the hints themselves never depend on it.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import './hintLamp.css'

export interface HintLampProps {
  /**
   * Distinguishes this lamp from every other, for remembering whether it has been noticed.
   * A screen name is the right granularity.
   */
  id: string
  /**
   * The hints. Each is one short paragraph.
   *
   * These answer what somebody *wonders*. Anything a person has to know in order to use the
   * screen at all belongs on the screen instead — see the header.
   */
  hints: readonly string[]
  /** Announced to a screen reader on the button. */
  label?: string
}

const NOTICED_KEY = 'twm.lamp.noticed.v1'

function alreadyNoticed(id: string): boolean {
  try {
    const raw = window.localStorage.getItem(NOTICED_KEY)
    return raw !== null && (JSON.parse(raw) as unknown[]).includes(id)
  } catch {
    // A private window, or a full quota. Glowing again is a small cost; failing to render the
    // lamp over it would be a large one.
    return false
  }
}

function remember(id: string): void {
  try {
    const raw = window.localStorage.getItem(NOTICED_KEY)
    const seen = raw === null ? [] : (JSON.parse(raw) as unknown[])
    if (!seen.includes(id)) {
      window.localStorage.setItem(NOTICED_KEY, JSON.stringify([...seen, id]))
    }
  } catch {
    /* nothing worth doing */
  }
}

export function HintLamp({ id, hints, label = 'Hints' }: HintLampProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [glow, setGlow] = useState(false)
  const panelId = useId()
  const noticed = useRef(true)

  useEffect(() => {
    noticed.current = alreadyNoticed(id)
    setGlow(!noticed.current)
  }, [id])

  const toggle = useCallback(() => {
    setOpen(was => !was)
    // Pressing it is the strongest possible signal that it has been noticed.
    setGlow(false)
    remember(id)
  }, [id])

  return (
    <div className={`lamp${open ? ' lamp--open' : ''}`}>
      <button
        type="button"
        className={`lamp__button${glow ? ' lamp__button--glow' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {/* A drawn lamp rather than a lightbulb glyph: a shade, a stem, and a pool of light
            that only exists when it is on. The bulb inside is what changes, so pressing it
            reads as a switch rather than as a button that happens to have a picture on it. */}
        <svg className="lamp__glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path className="lamp__shade" d="M12 3 L18.5 12 H5.5 Z" />
          <line className="lamp__stem" x1="12" y1="12" x2="12" y2="19.5" />
          <line className="lamp__base" x1="8.5" y1="20.5" x2="15.5" y2="20.5" />
          <circle className="lamp__bulb" cx="12" cy="14" r="1.6" />
          {/* The light. Two rays that only appear when it is on — the whole state change. */}
          <g className="lamp__rays">
            <line x1="6.6" y1="15.4" x2="4.2" y2="16.8" />
            <line x1="17.4" y1="15.4" x2="19.8" y2="16.8" />
          </g>
        </svg>
        <span className="lamp__label">{label}</span>
      </button>

      {/* Rendered after the button and controlled by it, so a screen reader meets the hints
          immediately after the control that opened them, and Tab reaches them in one press. */}
      <div className="lamp__panel" id={panelId} hidden={!open}>
        <ul className="lamp__hints">
          {hints.map(hint => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
