/**
 * One pass at a routine: watch it, try it, be told one thing.
 *
 * ## The stage that was missing
 *
 * `watch → counting → dancing → judging → done`. The first version began at `counting`: it
 * held the exact intended pose at every beat of every routine and showed the learner none of
 * them, then scored the attempt. Observational modelling is the oldest result in motor
 * learning and the effect is much larger for how a movement is *shaped* than for whether it
 * hits a target — which is all a dance is.
 *
 * So the demonstration comes first, it loops until the learner says they are ready, and it is
 * available again from the result. Nobody is made to watch a fixed number of repetitions:
 * letting learners choose when to see the model beats a fixed schedule, and the number people
 * choose for themselves is usually about right.
 *
 * ## Back view by default
 *
 * The figure is shown from behind, so the learner copies directly rather than translating.
 * That is not the obvious choice — mirroring is the folk answer — but a preregistered study
 * of dancers learning choreography from video found back view beat both front-mirrored and
 * front-opposite on accuracy, spatial skills and rhythm. Front is one tap away for anybody who
 * prefers it, and the scorer accepts either, so nothing rides on the default being right for
 * everybody.
 *
 * ## Nothing is drawn over the learner while they dance
 *
 * No ghost, no skeleton overlay, no live score. Two independent reasons, and they agree.
 * Concurrent augmented feedback reliably improves performance *during* practice and degrades
 * it on retention — the learner outsources error detection to the display instead of building
 * their own. And dancers asked about exactly this rejected it: an overlay covers the thing
 * you are trying to look at. So the attempt screen shows the learner, a ring that empties, and
 * the beat. The judgement comes afterwards, when it can be acted on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { Dancer } from './Dancer'
import { CameraError, FPS, capture, closeCamera, openCamera } from './camera'
import { createMetronome, type Metronome } from './metronome'
import { VIEW_TURN } from './kinematics'
import { toSkeleton } from './pose'
import { beatsIn, callAt, poseAt, secondsFor, toSequence, type Routine } from './routines'
import { scoreRoutine, type Verdict } from './score'

type Stage = 'watch' | 'counting' | 'dancing' | 'judging' | 'guessing' | 'done' | 'failed'

/**
 * What the learner is asked before the score is shown.
 *
 * ## Why there is a step between finishing and finding out
 *
 * Two manipulations of feedback have better support than simply giving less of it, and both
 * are cheap in a UI. **Self-controlled feedback** — letting the learner decide when to see
 * it — beats a fixed schedule at retention and transfer. And **asking for an estimate first**
 * is the one that matters most here: being made to judge your own attempt before the answer
 * arrives is what builds error detection, which is the capacity a score otherwise quietly
 * replaces. A learner who is handed a number every time stops forming an opinion, and then
 * has nothing when the number goes away.
 *
 * It is one tap and it is skippable. The bands are deliberately words rather than numbers —
 * guessing "68" is a different and much worse task than knowing whether that felt right.
 */
const GUESSES = [
  { id: 'rough', say: 'Bit of a mess', low: 0, high: 45 },
  { id: 'getting', say: 'Getting there', low: 40, high: 70 },
  { id: 'good', say: 'That felt good', low: 65, high: 90 },
  { id: 'nailed', say: 'Nailed it', low: 85, high: 100 },
] as const

/** Beats of count-in. Four is one bar, which is what a person expects. */
const COUNT_IN = 4

export interface DanceFloorProps {
  routine: Routine
  onLeave: () => void
}

export function DanceFloor({ routine, onLeave }: DanceFloorProps): React.ReactElement {
  const [stage, setStage] = useState<Stage>('watch')
  const [count, setCount] = useState(COUNT_IN)
  const [through, setThrough] = useState(0)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [seen, setSeen] = useState(true)
  /** Seen from behind by default — see the header. */
  const [facing, setFacing] = useState(false)
  const [beat, setBeat] = useState(0)
  /** What they said before they were told. Null when they skipped the question. */
  const [guess, setGuess] = useState<(typeof GUESSES)[number] | null>(null)

  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const clock = useRef<Metronome | null>(null)
  const stopping = useRef<AbortController | null>(null)

  const seconds = secondsFor(routine)
  const span = beatsIn(routine)
  const sequence = useRef(toSequence(routine, 8)).current

  // The camera light staying on after somebody leaves is the kind of thing people notice
  // once and never forgive. The metronome has to stop for the same reason.
  useEffect(() => {
    return () => {
      closeCamera(stream.current)
      clock.current?.stop()
      stopping.current?.abort()
    }
  }, [])

  /* ------------------------------------------------------------- the demo */

  // Driven by a clock rather than a frame counter, so a phone that drops frames shows the
  // dance late rather than slow — and stays with the click, which is on the audio clock and
  // does not drift.
  useEffect(() => {
    if (stage !== 'watch') return

    const metronome = createMetronome({
      bpm: routine.bpm,
      perBar: Math.max(2, Math.round(span)),
    })
    clock.current = metronome
    let live = true
    let frame = 0

    // Autoplay policy means this may be refused until the person has tapped something. The
    // figure still moves; only the click is missing, so it fails quietly.
    void metronome.start().catch(() => undefined)

    const tick = (): void => {
      if (!live) return
      const at = metronome.elapsed()
      if (at !== null) setBeat(((at / 60) * routine.bpm) % span)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      live = false
      cancelAnimationFrame(frame)
      metronome.stop()
      clock.current = null
    }
  }, [stage, routine.bpm, span])

  const turn = facing ? VIEW_TURN : Math.PI + VIEW_TURN

  /* ---------------------------------------------------------- the attempt */

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

    // One metronome for the count-in and the attempt, so the four beats somebody is counted
    // in on are the same four beats the routine then runs at.
    const metronome = createMetronome({ bpm: routine.bpm, perBar: Math.max(2, Math.round(span)) })
    clock.current = metronome
    await metronome.start().catch(() => undefined)

    setStage('counting')
    const beatMs = (60 / routine.bpm) * 1000
    for (let left = COUNT_IN; left > 0; left -= 1) {
      setCount(left)
      await new Promise(resolve => setTimeout(resolve, beatMs))
    }

    setStage('dancing')
    const halt = new AbortController()
    stopping.current = halt
    const taken = await capture(
      video.current!,
      seconds,
      (landmarks, done) => {
        setThrough(done)
        // Told once, quietly, while there is still time to step back into frame — rather than
        // afterwards, when the only thing left to say is "that did not work".
        setSeen(landmarks !== null)
      },
      halt.signal,
    )
    stopping.current = null

    closeCamera(stream.current)
    stream.current = null
    metronome.stop()
    clock.current = null
    setStage('judging')

    // Off the render path: this is a few hundred frames of arithmetic and it must not happen
    // inside a state update.
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

    // The tempo is what lets a drift in frames be said in beats — and `beatsPerCycle` is
    // what stops a routine offset by a whole repetition being called late, because a cyclic
    // dance a cycle behind is the same dance.
    setVerdict(
      scoreRoutine(toSequence(routine, FPS), learner, {
        framesPerBeat: (60 / routine.bpm) * FPS,
        beatsPerCycle: span,
      }),
    )
    setStage('guessing')
    // The landmarks go out of scope here and are never stored. See the note in camera.ts: a
    // time series of joint positions is a gait signature.
  }, [routine, seconds, span])

  const watching = stage === 'watch'
  const call = callAt(routine, beat)

  return (
    <section className="floor">
      <button type="button" className="floor__back" onClick={onLeave}>
        ‹ Dances
      </button>

      <header className="floor__head">
        <h2 className="floor__name">{routine.name}</h2>
        {watching && <p className="floor__hint">{routine.hint}</p>}
      </header>

      <div className="floor__stage">
        <video
          ref={video}
          className={`floor__video${watching || stage === 'failed' ? ' floor__video--off' : ''}`}
          playsInline
          muted
        />

        {watching && (
          <div className="floor__demo">
            <div className="floor__demoFigure">
              <Dancer
                pose={poseAt(routine.keys, beat)}
                extent={sequence}
                turn={turn}
                label={`A figure demonstrating ${routine.name}`}
              />
            </div>
            <div className="floor__demoFoot">
              {/* The words a teacher says, rather than a number. "Forward, side, together" is
                  what people remember; "one, two, three" is what they lose. */}
              <span className={`floor__call${call === '' ? ' floor__callDim' : ''}`}>
                {call === '' ? `${Math.floor(beat) + 1}` : call}
              </span>
              <button
                type="button"
                className="floor__viewToggle"
                onClick={() => setFacing(one => !one)}
              >
                {facing ? 'Show me from behind' : 'Turn to face me'}
              </button>
            </div>
          </div>
        )}

        {stage === 'failed' && (
          <div className="floor__empty">
            <p>{problem}</p>
            <p className="floor__emptySub">
              Prop the phone at about waist height and stand back until your head and feet are both
              in the picture.
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

      {watching && (
        <div className="floor__actions">
          <button type="button" className="floor__go" onClick={() => void run()}>
            I’ll try it — {Math.round(seconds)}s
          </button>
        </div>
      )}

      {stage === 'dancing' && (
        <div className="floor__actions">
          {/* A real way out. Without it the only exit mid-attempt was to leave the screen,
              which left the detector running against a torn-down stream for the remaining
              seconds. */}
          <button type="button" className="floor__second" onClick={() => stopping.current?.abort()}>
            Stop
          </button>
        </div>
      )}

      {stage === 'failed' && (
        <div className="floor__actions">
          <button type="button" className="floor__go" onClick={() => setStage('watch')}>
            Watch it again
          </button>
        </div>
      )}

      {stage === 'guessing' && (
        <div className="floor__guess">
          <p className="floor__guessAsk">Before you look — how did that feel?</p>
          <div className="floor__guessRow">
            {GUESSES.map(one => (
              <button
                key={one.id}
                type="button"
                className="floor__guessOne"
                onClick={() => {
                  setGuess(one)
                  setStage('done')
                }}
              >
                {one.say}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="floor__leave"
            onClick={() => {
              setGuess(null)
              setStage('done')
            }}
          >
            Just show me
          </button>
        </div>
      )}

      {stage === 'done' && verdict !== null && (
        <Result
          verdict={verdict}
          guess={guess}
          onAgain={() => {
            setGuess(null)
            void run()
          }}
          onWatch={() => setStage('watch')}
          onLeave={onLeave}
        />
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

function Result({
  verdict,
  guess,
  onAgain,
  onWatch,
  onLeave,
}: {
  verdict: Verdict
  guess: { say: string; low: number; high: number } | null
  onAgain: () => void
  onWatch: () => void
  onLeave: () => void
}): React.ReactElement {
  // The bars are mounted empty and filled on the next frame. Without this the transition in
  // the stylesheet never plays — a width set at mount has nothing to grow from, and this was
  // one of four animations in these chapters that were written and never ran.
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const graded = verdict.limbs.filter(one => one.asked >= 0.1).sort((a, b) => a.score - b.score)

  return (
    <div className="floor__verdict">
      {/* The sentence, first and largest.
          
          The stylesheet has carried a comment reading "bigger than the number, because it is
          the part worth reading" since the day it was written, above a rule setting it to a
          third of the number's size, under a heading that was the first thing on the screen.
          A score tells somebody where they are; this tells them what to do next, and it is
          the only line most people will read. */}
      <p className="verdict__note">{verdict.note}</p>

      {/* Whether they read their own attempt correctly, which is the skill actually worth
          building — "you knew" is more useful to learn about yourself than any one score. */}
      {guess !== null && (
        <p className="verdict__guess">
          {verdict.score >= guess.low && verdict.score <= guess.high
            ? `You called it — “${guess.say.toLowerCase()}” was about right.`
            : verdict.score > guess.high
              ? `Better than you thought. You said “${guess.say.toLowerCase()}”.`
              : `You were kinder to yourself than that one deserved — you said “${guess.say.toLowerCase()}”.`}
        </p>
      )}

      <div className="verdict__score">
        <span className="verdict__number">{verdict.score}</span>
        <span className="verdict__outOf">out of 100</span>
        {/* Computed on every verdict since the day mirroring was added, and rendered nowhere.
            Somebody who danced it mirrored deserves to know the app noticed and did not mind,
            or they will spend the next attempt worrying about which arm. */}
        {verdict.mirrored && <span className="verdict__mirrored">read as a mirror image</span>}
      </div>

      {/* Folded away. `score.ts` argues twice that feedback must name one thing, because
          somebody told four things fixes none of them — and then this list said five. */}
      <details className="verdict__detail">
        <summary>Show the detail</summary>
        <ul className="verdict__limbs">
          {/* Limbs the routine never asks to move say nothing, and a row reading "your legs:
              100" for a dance with no legs in it is noise dressed as information. */}
          {graded.map(limb => (
            <li key={limb.limb} className="verdict__limb">
              <span className="verdict__limbName">{LABEL[limb.limb]}</span>
              <span className="verdict__bar" aria-hidden="true">
                <span style={{ width: grown ? `${limb.score}%` : '0%' }} />
              </span>
              <span className="verdict__limbScore">{limb.score}</span>
            </li>
          ))}
        </ul>
      </details>

      <div className="floor__after">
        <button type="button" className="floor__go" onClick={onAgain}>
          Again
        </button>
        <button type="button" className="floor__second" onClick={onWatch}>
          Watch it
        </button>
        <button type="button" className="floor__leave" onClick={onLeave}>
          Pick another
        </button>
      </div>
    </div>
  )
}
