/**
 * Dance.
 *
 * A chapter, like Games: a few steps today and room for more. Everything here is meant to be
 * done in a kitchen by two people who cannot dance, which is the only audience this app has.
 * The scoring exists to make that funny and slightly competitive, not to train anybody.
 *
 * ## Two things the first version got wrong, both visible in a screenshot
 *
 * It **claimed to be a dark chapter and was not**. The stylesheet opened by saying so and
 * then used `--sapList_Background` for every card, so the only dark thing on the screen was a
 * 52px square repeated four times. It now goes dark properly, the way the quiz does, because
 * both are performances in a room rather than documents on a screen.
 *
 * And **the four cards were identical** — the same gradient, the same drifting dot — which
 * tells the eye that four things are interchangeable. That is the opposite of what a menu is
 * for. Each card now shows the routine's own most characteristic pose, drawn from its
 * keyframes, so you can see what you are choosing before you choose it.
 *
 * The camera and the detector are a lazy import inside a lazy route — several megabytes of
 * WebAssembly that has no business in the bundle of somebody who only ever scans receipts.
 */
import { Suspense, lazy, useMemo, useState } from 'react'

import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Dancer, signaturePose } from './dance/Dancer'
import { ROUTINES, secondsFor, toSequence, type Routine } from './dance/routines'
import './dance/dance.css'

const DanceFloor = lazy(async () => ({
  default: (await import('./dance/DanceFloor')).DanceFloor,
}))

export function DancePage(): React.ReactElement {
  const [chosen, setChosen] = useState<Routine | null>(null)

  // Sampled coarsely: the card only needs one pose, and interpolating four routines at full
  // rate to pick one frame would be a hundred times the work for the same picture.
  const glyphs = useMemo(
    () =>
      ROUTINES.map(routine => {
        const sequence = toSequence(routine, 6)
        return { routine, pose: signaturePose(sequence), sequence }
      }),
    [],
  )

  if (chosen !== null) {
    return (
      <section className="dance dance--floor">
        <Suspense fallback={<LoadingSkeleton />}>
          <DanceFloor routine={chosen} onLeave={() => setChosen(null)} />
        </Suspense>
      </section>
    )
  }

  return (
    <section className="dance">
      <header className="dance__head">
        {/* The kicker: the app's most identifiable typographic mark, and the chapter had
            none of it. */}
        <p className="dance__kicker">Four steps</p>
        <h2 className="dance__title">Dance</h2>
        <p className="dance__lede">
          Prop the phone up and pick a step. It shows you the move, counts you in, watches, and
          tells you one thing afterwards.
        </p>
      </header>

      <ul className="steps">
        {glyphs.map(({ routine, pose, sequence }) => (
          <li key={routine.id}>
            <button type="button" className="step" onClick={() => setChosen(routine)}>
              <span className="step__art">
                <Dancer pose={pose} extent={sequence} />
              </span>
              <span className="step__body">
                <span className="step__name">{routine.name}</span>
                <span className="step__blurb">{routine.blurb}</span>
                <span className="step__meta">
                  <span className="step__stat">{Math.round(secondsFor(routine))}s</span>
                  <span className="step__dot" aria-hidden="true" />
                  <span className="step__stat">{routine.bpm} bpm</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Said here, before anybody turns a camera on, rather than in a settings page nobody
          opens. It is also simply true, which is the only reason it is worth saying. */}
      <p className="dance__privacy">
        The camera never leaves this device. Nothing is recorded, nothing is uploaded, and the
        positions it reads are thrown away the moment it has worked out a score.
      </p>
    </section>
  )
}
