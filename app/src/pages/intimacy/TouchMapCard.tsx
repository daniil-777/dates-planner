/**
 * One person's map: the figure, the palette, and the list of regions.
 *
 * ## A canvas with a palette, not a form with an illustration
 *
 * The loop used to run the other way: tap a region, and *then* four level buttons appeared
 * below the figure to answer with. It did not work on a phone. The buttons rendered under the
 * fold behind the tab bar, the only other feedback was a highlight measuring 1.17:1, and the
 * canvas swallowed the scroll that would have gone looking for either — so the first tap
 * produced nothing anybody could see, nineteen times over at two taps and two long scrolls
 * each.
 *
 * Now you pick a colour and paint. One tap plus *n*, and five things fall out of the one
 * change: the four words are on screen from the moment the page opens (they appeared nowhere
 * at all before a successful selection), the palette doubles as the legend the figure has
 * never had — open a partner's map today and you get four unexplained hues with no key
 * anywhere in the app — unmarking needs no second control, the editor disappears, and there
 * is no longer anything that can render below the fold.
 *
 * ## Two ways in, on purpose
 *
 * A region can be chosen by tapping the figure or by picking it out of the list, and both
 * do exactly the same thing. That is not redundancy for its own sake — the figure is the
 * pleasant way and the list is the reliable one. The list works from a keyboard, works for
 * a screen reader, works when a region is on the far side of the model, and works when
 * somebody is not sure what a region is called. The figure is what makes it feel like
 * anything at all.
 *
 * ## Editing yours, reading theirs
 *
 * The same card renders both, because seeing your partner's map in the same shape as your
 * own is the point of the feature. `editable` is false for theirs: the figure stops
 * accepting taps, the level buttons disappear, and the region list becomes prose. The
 * server enforces this independently — `guardBodyMapWrite`, CONTRACTS.md §13.3 — so this
 * is presentation, not protection.
 */
import { useMemo, useState } from 'react'
import { Text } from '@ui5/webcomponents-react'

import { BodyCanvas } from './BodyCanvas'
import type { Mark } from './api'
import {
  FORMS,
  FORM_LABEL,
  LEVEL_SPECS,
  ZONE_LABEL,
  ZONE_ORDER,
  levelSpec,
  type BodyForm,
  type Level,
  type ZoneCode,
} from './zones'

/** Unmarked body colour. Warm and light in both themes — the marks carry the contrast. */
const BASE_LIGHT = '#d8c3b4'
const BASE_DARK = '#8d7566'

export interface TouchMapCardProps {
  personName: string
  form: BodyForm
  marks: readonly Mark[]
  editable: boolean
  busy: boolean
  onChangeForm: (form: BodyForm) => void
  /** Level `null` clears the region. Never called when `editable` is false. */
  onSetLevel: (zone: ZoneCode, level: Level | null) => void
}

export function TouchMapCard({
  personName,
  form,
  marks,
  editable,
  busy,
  onChangeForm,
  onSetLevel,
}: TouchMapCardProps) {
  /**
   * The armed colour. `null` is nothing armed, which is how the card opens.
   *
   * Deliberately not defaulting to a level: arming one would mean the first curious tap on
   * the figure silently records an answer about somebody's body, and this is the wrong screen
   * on which to have a default opinion.
   */
  const [brush, setBrush] = useState<Level | null>(null)
  /** Only used on the no-brush path, so the old order is never a dead end. */
  const [selected, setSelected] = useState<ZoneCode | null>(null)

  const byZone = useMemo(() => new Map(marks.map(mark => [mark.zone, mark])), [marks])

  // Zone → the colour it paints on the figure. Rebuilt only when the marks change, because
  // it is handed to the canvas as a prop and a fresh Map on every render would repaint the
  // whole vertex buffer on every unrelated keystroke.
  const painted = useMemo(() => {
    const map = new Map<ZoneCode, string>()
    for (const mark of marks) map.set(mark.zone, levelSpec(mark.level).colour)
    return map
  }, [marks])

  const dark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches

  const marked = ZONE_ORDER.filter(zone => byZone.has(zone))

  /**
   * What the caption says, which is also what a screen reader is told.
   *
   * One line doing three jobs — the instruction before anything has happened, the
   * confirmation after a mark, and the way out of a tap with no colour armed.
   */
  const [said, setSaid] = useState<string | null>(null)

  const touch = (zone: ZoneCode): void => {
    if (!editable) return

    if (brush === null) {
      // Somebody who tapped the body first rather than the palette. Not an error, and not a
      // dead end — name what they touched and say what is missing.
      setSelected(zone)
      setSaid(`${ZONE_LABEL[zone]}. Now pick a colour.`)
      return
    }

    const existing = byZone.get(zone)
    const same = existing !== undefined && existing.level === brush
    onSetLevel(zone, same ? null : brush)
    setSelected(null)
    setSaid(
      same
        ? `${ZONE_LABEL[zone]} — cleared.`
        : `${ZONE_LABEL[zone]} — ${levelSpec(brush).label}. Tap it again to unsay it.`,
    )
  }

  return (
    <section className="tmap" aria-label={`${personName}'s map`}>
      <header className="tmap__head">
        <div>
          <h2 className="tmap__who">{personName}</h2>
          <Text className="tmap__sub">
            {editable
              ? 'Drag sideways to turn it.'
              : `${marked.length === 0 ? 'Nothing marked yet' : `${marked.length} marked`} · read only`}
          </Text>
        </div>

        {editable && (
          <div className="tmap__forms" role="group" aria-label="Figure">
            {FORMS.map(option => (
              <button
                key={option}
                type="button"
                className="tmap__form"
                aria-pressed={option === form}
                disabled={busy}
                onClick={() => onChangeForm(option)}
              >
                {FORM_LABEL[option]}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="tmap__figure">
        <BodyCanvas
          form={form}
          marks={painted}
          highlighted={selected}
          onPick={editable ? touch : null}
          baseColour={dark ? BASE_DARK : BASE_LIGHT}
        />
        <p className="tmap__hint">Drag to turn · pinch to zoom</p>
      </div>

      {/*
        The palette. Sticky at the bottom, always present, never conditional on a selection.

        Bottom rather than top because the shell bar is already `sticky; top: 0` — a
        top-sticky palette would slide underneath an opaque header exactly when somebody
        scrolls into the region list, which is the same class of bug this replaced.
      */}
      {editable && (
        <div className="tmap__palette">
          <div className="tmap__brushes" role="group" aria-label="Pick a colour">
            {LEVEL_SPECS.map(spec => {
              const armed = brush === spec.level
              return (
                <button
                  key={spec.level}
                  type="button"
                  className={`tmap__brush${spec.level === -1 ? ' tmap__brush--apart' : ''}`}
                  aria-pressed={armed}
                  style={
                    armed
                      ? { background: spec.colour, color: spec.ink, borderColor: spec.colour }
                      : undefined
                  }
                  onClick={() => {
                    const next = armed ? null : spec.level
                    setBrush(next)
                    // Somebody who tapped a region first, then a colour: finish the job they
                    // started rather than making them tap the body again.
                    if (next !== null && selected !== null) {
                      const existing = byZone.get(selected)
                      const same = existing !== undefined && existing.level === next
                      onSetLevel(selected, same ? null : next)
                      setSaid(
                        `${ZONE_LABEL[selected]} — ${same ? 'cleared' : spec.label}. Tap it again to unsay it.`,
                      )
                      setSelected(null)
                    }
                  }}
                >
                  <span
                    className="tmap__brushDot"
                    style={{ background: spec.colour }}
                    aria-hidden="true"
                  />
                  {spec.label}
                </button>
              )
            })}
          </div>

          {/*
            One line, three jobs: the instruction before anything happens, the confirmation
            after a mark, and the way out of a tap with no colour armed. Announced, because
            activating a list row used to change the screen and tell a screen reader nothing.
          */}
          <p className="tmap__say" aria-live="polite">
            {said ?? 'Pick a colour, then tap the body.'}
          </p>

          {marked.length === 0 && said === null && (
            <p className="tmap__nofinish">
              There is no finishing this. Mark one thing or twenty, and change any of it whenever
              you like.
            </p>
          )}
        </div>
      )}

      {/* Every region, always rendered: this is the keyboard and screen-reader path in. */}
      <div className="tmap__zones">
        <p className="tmap__zonesLabel">
          {editable
            ? marked.length === 0
              ? 'Or choose from the list'
              : `${marked.length} marked · or choose from the list`
            : `What ${personName} has said`}
        </p>
        <ul className="tmap__list">
          {(editable ? ZONE_ORDER : marked).map(zone => {
            const mark = byZone.get(zone)
            const spec = mark === undefined ? null : levelSpec(mark.level)
            return (
              <li key={zone}>
                <button
                  type="button"
                  className="tmap__zone"
                  aria-pressed={editable ? zone === selected : undefined}
                  disabled={!editable}
                  // The same handler as the figure, not `setSelected`. They were different
                  // for one commit and it showed: a list row armed the old selection
                  // highlight instead of painting, so tapping "Shoulders" with Favourite
                  // armed turned the shoulders the highlight colour rather than magenta.
                  onClick={() => touch(zone)}
                >
                  <span
                    className="tmap__swatch"
                    data-marked={spec === null ? 'false' : 'true'}
                    style={spec === null ? undefined : { background: spec.colour }}
                    aria-hidden="true"
                  />
                  <span className="tmap__zoneName">{ZONE_LABEL[zone]}</span>
                  {/* No em dash on an unmarked row. Nineteen of them read as nineteen
                      unanswered questions, and absence here is not a skipped question. */}
                  <span className="tmap__zoneLevel">{spec === null ? '' : spec.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {!editable && marked.length === 0 && <p className="tmap__empty">Nothing here yet.</p>}
      </div>
    </section>
  )
}
