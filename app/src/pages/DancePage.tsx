/**
 * Dance.
 *
 * A chapter, like Games: a few steps today and room for more. Everything here is meant to be
 * done in a kitchen by two people who cannot dance, which is the only audience this app has.
 * The scoring exists to make that funny and slightly competitive, not to train anybody.
 *
 * The camera and the detector are a lazy import inside a lazy route — several megabytes of
 * WebAssembly that has no business in the bundle of somebody who only ever scans receipts.
 */
import { Suspense, lazy, useState } from 'react'
import { Title } from '@ui5/webcomponents-react'

import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { ROUTINES, secondsFor, type Routine } from './dance/routines'
import './dance/dance.css'

const DanceFloor = lazy(async () => ({
  default: (await import('./dance/DanceFloor')).DanceFloor,
}))

export function DancePage(): React.ReactElement {
  const [chosen, setChosen] = useState<Routine | null>(null)

  if (chosen !== null) {
    return (
      <section className="dance">
        <Suspense fallback={<LoadingSkeleton />}>
          <DanceFloor routine={chosen} onLeave={() => setChosen(null)} />
        </Suspense>
      </section>
    )
  }

  return (
    <section className="dance">
      <header className="dance__head">
        <Title level="H2">Dance</Title>
        <p className="dance__lede">
          Prop the phone up, pick a step, and try it. It watches, counts you in, and tells you one
          thing afterwards.
        </p>
      </header>

      <ul className="steps">
        {ROUTINES.map(routine => (
          <li key={routine.id}>
            <button type="button" className="step" onClick={() => setChosen(routine)}>
              <span className="step__art" aria-hidden="true">
                <span className="step__figure" />
              </span>
              <span className="step__body">
                <span className="step__name">{routine.name}</span>
                <span className="step__blurb">{routine.blurb}</span>
                <span className="step__meta">
                  {Math.round(secondsFor(routine))} seconds · {routine.bpm} bpm
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
