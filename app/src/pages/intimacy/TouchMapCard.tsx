/**
 * One person's map: the figure, the form switcher, and the list of regions.
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
import { Button, Text } from '@ui5/webcomponents-react'

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
  const current = selected === null ? null : (byZone.get(selected) ?? null)

  return (
    <section className="tmap" aria-label={`${personName}'s map`}>
      <header className="tmap__head">
        <div>
          <h2 className="tmap__who">{personName}</h2>
          <Text className="tmap__sub">
            {editable
              ? 'Turn the figure, then choose a region.'
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
          onPick={editable ? setSelected : null}
          baseColour={dark ? BASE_DARK : BASE_LIGHT}
        />
        <p className="tmap__hint">Drag to turn · pinch to zoom</p>
      </div>

      {/* The chosen region and what to say about it. Only ever shown for your own map. */}
      {editable && selected !== null && (
        <div className="tmap__editor">
          <div className="tmap__editorHead">
            <span className="tmap__editorZone">{ZONE_LABEL[selected]}</span>
            {/* No accessibleName: it would replace the visible word rather than add to
                it, and an accessible name that does not contain the label somebody can
                see is exactly what WCAG 2.5.3 is about — voice control users say "Done"
                because that is what the button says. */}
            <Button design="Transparent" onClick={() => setSelected(null)}>
              Done
            </Button>
          </div>
          <div
            className="tmap__levels"
            role="group"
            aria-label={`How you feel about ${ZONE_LABEL[selected]}`}
          >
            {LEVEL_SPECS.map(spec => {
              const active = current?.level === spec.level
              return (
                <button
                  key={spec.level}
                  type="button"
                  className="tmap__level"
                  aria-pressed={active}
                  disabled={busy}
                  style={
                    active
                      ? { background: spec.colour, color: spec.ink, borderColor: spec.colour }
                      : undefined
                  }
                  onClick={() => onSetLevel(selected, active ? null : spec.level)}
                >
                  {spec.label}
                </button>
              )
            })}
          </div>
          <p className="tmap__clear">
            {current === null
              ? 'Nothing said about this one yet.'
              : 'Tap the same one again to unsay it.'}
          </p>
        </div>
      )}

      {/* Every region, always rendered: this is the keyboard and screen-reader path in. */}
      <div className="tmap__zones">
        <p className="tmap__zonesLabel">
          {editable ? 'Every region' : `What ${personName} has said`}
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
                  onClick={() => setSelected(zone)}
                >
                  <span
                    className="tmap__swatch"
                    style={spec === null ? undefined : { background: spec.colour }}
                    aria-hidden="true"
                  />
                  <span className="tmap__zoneName">{ZONE_LABEL[zone]}</span>
                  <span className="tmap__zoneLevel">
                    {spec === null ? (editable ? '—' : '') : spec.label}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {!editable && marked.length === 0 && (
          <p className="tmap__empty">{personName} has not marked anything yet.</p>
        )}
      </div>
    </section>
  )
}
