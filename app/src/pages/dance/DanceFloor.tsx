/**
 * One attempt at a routine: count in, dance, get told one thing.
 *
 * ## The shape of it
 *
 * `ready → counting → dancing → judging → done`. The count-in is not decoration. Somebody
 * who starts recording and *then* looks for the beat has already lost the first bar, and the
 * first bar is where the scorer decides what your timing looks like. Four beats of "three,
 * two, one" is the difference between a fair score and an unfair one.
 *
 * ## What is on screen while dancing, and what is deliberately not
 *
 * A preview of yourself, a ring that empties, and a dot that pulses on the beat. Nothing
 * else — no live score, no skeleton overlay, no per-limb meter.
 *
 * That is a considered omission. A live score makes people watch the number instead of
 * moving, and a skeleton overlay makes them watch the skeleton; both produce somebody
 * standing very still trying to make a graph go up, which is the opposite of dancing. The
 * feedback comes afterwards, when it can be acted on.
 *
 * The preview is mirrored, because a preview that is not mirrored is unusable — everybody
 * has spent their life in mirrors and a lateral flip makes people move the wrong way.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { CameraError, FPS, capture, closeCamera, openCamera } from './camera'
import { toSkeleton, type Landmarks } from './pose'
import { secondsFor, toSequence, type Routine } from './routines'
import { scoreRoutine, type Verdict } from './score'

type Stage = 'ready' | 'counting' | 'dancing' | 'judging' | 'done' | 'failed'

/** Beats of count-in. Four is one bar, which is what a person expects. */
const COUNT_IN = 4

export interface DanceFloorProps {
  routine: Routine
  onLeave: () => void
}

export function DanceFloor({ routine, onLeave }: DanceFloorProps): React.ReactElement {
  const [stage, setStage] = useState<Stage>('ready')
  const [count, setCount] = useState(COUNT_IN)
  const [through, setThrough] = useState(0)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [seen, setSeen] = useState(true)

  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)

  const seconds = secondsFor(routine)

  // The camera light staying on after somebody leaves is the kind of thing people notice
  // once and never forgive.
  useEffect(() => {
    return () => closeCamera(stream.current)
  }, [])

  const run = useCallback(async () => {
    setProblem(null)
    try {
      const opened = await openCamera()
      stream.current = opened
      if (video.current !== null) {
        video.current.srcObject = opened
        await video.current.play()
      }
    } catch (error) {
      setProblem(error instanceof CameraError ? error.safeMessage : 'The camera could not start.')
      setStage('failed')
      return
    }

    // Count in.
    setStage('counting')
    const beat = (60 / routine.bpm) * 1000
    for (let left = COUNT_IN; left > 0; left -= 1) {
      setCount(left)
      await new Promise(resolve => setTimeout(resolve, beat))
    }

    setStage('dancing')
    const frames: Landmarks[] = []
    const taken = await capture(video.current!, seconds, (landmarks, done) => {
      setThrough(done)
      // Told once, quietly, while there is still time to step back into frame — rather than
      // afterwards, when the only thing left to say is "that did not work".
      setSeen(landmarks !== null)
      if (landmarks !== null) frames.push(landmarks)
    })

    closeCamera(stream.current)
    stream.current = null
    setStage('judging')

    // Off the render path: this is a few hundred frames of arithmetic and it must not
    // happen inside a state update.
    await new Promise(resolve => setTimeout(resolve, 0))

    const learner = taken.frames
      .map(toSkeleton)
      .filter((one): one is NonNullable<typeof one> => one !== null)
    if (learner.length < FPS) {
      setProblem(
        'Not enough of you was in shot to score that. Step back so your head and feet are both in the picture.',
      )
      setStage('failed')
      return
    }

    setVerdict(scoreRoutine(toSequence(routine, FPS), learner))
    setStage('done')
    // The landmarks go out of scope here and are never stored. See the note in camera.ts:
    // a time series of joint positions is a gait signature.
    frames.length = 0
  }, [routine, seconds])

  return (
    <section className="floor">
      <button type="button" className="floor__back" onClick={onLeave}>
        ‹ Dances
      </button>

      <header className="floor__head">
        <h2 className="floor__name">{routine.name}</h2>
        {stage === 'ready' && <p className="floor__hint">{routine.hint}</p>}
      </header>

      <div className="floor__stage">
        <video
          ref={video}
          className={`floor__video${stage === 'ready' || stage === 'failed' ? ' floor__video--off' : ''}`}
          playsInline
          muted
        />

        {/* Not a black rectangle. Somebody looking at an empty stage does not know whether
            to stand up, and the two things that actually decide whether a capture works —
            where the phone goes and where they stand — belong here rather than in a
            paragraph underneath that they will read afterwards. */}
        {(stage === 'ready' || stage === 'failed') && (
          <div className="floor__empty">
            <span className="floor__emptyIcon" aria-hidden="true" />
            <p>Prop the phone against something at about waist height.</p>
            <p className="floor__emptySub">
              Stand back until your head and feet are both in the picture.
            </p>
          </div>
        )}

        {stage === 'counting' && (
          <div className="floor__count" aria-live="assertive">
            {count}
          </div>
        )}

        {stage === 'dancing' && (
          <>
            <svg className="floor__ring" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="floor__ringTrack" cx="50" cy="50" r="46" />
              <circle
                className="floor__ringFill"
                cx="50"
                cy="50"
                r="46"
                strokeDasharray={2 * Math.PI * 46}
                strokeDashoffset={2 * Math.PI * 46 * through}
              />
            </svg>
            <span
              className="floor__beat"
              style={{ animationDuration: `${(60 / routine.bpm).toFixed(3)}s` }}
              aria-hidden="true"
            />
            {!seen && <p className="floor__lost">Step back — I have lost you</p>}
          </>
        )}

        {stage === 'judging' && <p className="floor__judging">Working it out…</p>}
      </div>

      {stage === 'ready' && (
        <button type="button" className="floor__go" onClick={() => void run()}>
          Start — {Math.round(seconds)} seconds
        </button>
      )}

      {stage === 'failed' && (
        <div className="floor__failed">
          <p role="alert">{problem}</p>
          <button type="button" className="floor__go" onClick={() => setStage('ready')}>
            Try again
          </button>
        </div>
      )}

      {stage === 'done' && verdict !== null && (
        <div className="floor__verdict">
          <div className="verdict__score">
            <span className="verdict__number">{verdict.score}</span>
            <span className="verdict__outOf">out of 100</span>
          </div>

          {/* The sentence is the point, and it is bigger than the number on purpose. */}
          <p className="verdict__note">{verdict.note}</p>

          <ul className="verdict__limbs">
            {verdict.limbs
              // Limbs the routine never asks to move say nothing, and a row reading "your
              // legs: 100" for a dance with no legs in it is noise dressed as information.
              .filter(one => one.asked >= 0.1)
              .sort((a, b) => a.score - b.score)
              .map(limb => (
                <li key={limb.limb} className="verdict__limb">
                  <span className="verdict__limbName">{LABEL[limb.limb]}</span>
                  <span className="verdict__bar" aria-hidden="true">
                    <span style={{ width: `${limb.score}%` }} />
                  </span>
                  <span className="verdict__limbScore">{limb.score}</span>
                </li>
              ))}
          </ul>

          <div className="floor__after">
            <button type="button" className="floor__go" onClick={() => void run()}>
              Again
            </button>
            <button type="button" className="floor__leave" onClick={onLeave}>
              Pick another
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

/** Without the "your", which reads oddly in a table. */
const LABEL: Record<string, string> = {
  leftArm: 'Left arm',
  rightArm: 'Right arm',
  leftLeg: 'Left leg',
  rightLeg: 'Right leg',
  torso: 'Upper body',
}
