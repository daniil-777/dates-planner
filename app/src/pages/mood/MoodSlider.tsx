/*
 * The control.
 *
 * A real `<input type="range">` with its own appearance removed, not a div with pointer
 * handlers. That decision is the whole accessibility story of this screen and it is worth
 * being explicit about: a range input arrives with arrow keys, Home and End, page-up and
 * page-down, a drag that keeps tracking when the pointer leaves the element, touch
 * behaviour that does not fight the page's own scrolling, and an announcement contract
 * that assistive technology already understands. Every one of those would have to be
 * rebuilt, badly, on top of a div.
 *
 * What is custom is only the paint: the track is a gradient from the storm to the sun, and
 * the thumb is the fat white circle. Both are drawn by the browser's own pseudo-elements,
 * so the hit area is still the input's.
 *
 * ## What it announces
 *
 * `aria-valuetext` carries the word — "Good" — rather than the number, because 73 is not
 * an answer to "how are you". The number is still there for anybody who wants it, in
 * `aria-valuenow`, which the browser sets from `value`. The five ticks under the track are
 * the honest disclosure that this continuous-looking control resolves to five stored
 * levels; they are marked `aria-hidden` because the value text already says which one you
 * are on.
 */
import type { ChangeEvent, ReactElement } from 'react'

import {
  LEVEL_WORDS,
  VALUE_MAX,
  VALUE_MIN,
  levelForValue,
  valueForLevel,
  wordForValue,
} from './sky'

export interface MoodSliderProps {
  value: number
  onChange: (value: number) => void
  /** Labelled by the prompt above it, so the label is not repeated into the accessible name. */
  labelledBy?: string
}

export function MoodSlider({ value, onChange, labelledBy }: MoodSliderProps): ReactElement {
  const level = levelForValue(value)
  const word = wordForValue(value)
  const fraction = (value - VALUE_MIN) / (VALUE_MAX - VALUE_MIN)

  return (
    <div className="dial" style={{ '--dial-fraction': fraction } as React.CSSProperties}>
      <div className="dial__readout">
        <span className="dial__word">{word}</span>
        {/* The stored scale, said out loud rather than hidden. A slider that silently
            rounds is a slider that lies about its own resolution. */}
        <span className="dial__level">{level} of 5</span>
      </div>

      <div className="dial__rail">
        <input
          className="dial__input"
          type="range"
          min={VALUE_MIN}
          max={VALUE_MAX}
          step={1}
          value={value}
          aria-labelledby={labelledBy}
          aria-valuetext={word}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
        />
        <div className="dial__ticks" aria-hidden="true">
          {[1, 2, 3, 4, 5].map(stop => (
            <span
              key={stop}
              className={stop === level ? 'dial__tick dial__tick--on' : 'dial__tick'}
              style={
                {
                  '--tick-at': `${((valueForLevel(stop) - VALUE_MIN) / (VALUE_MAX - VALUE_MIN)) * 100}%`,
                } as React.CSSProperties
              }
            >
              <span className="dial__tick-dot" />
              <span className="dial__tick-word">{LEVEL_WORDS[stop]}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
