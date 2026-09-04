/**
 * A beat you can hear.
 *
 * ## Why this exists
 *
 * The chapter shipped with the beat as a pulsing dot and nothing else, and timing is one of
 * the three faults it grades somebody on. That is close to the worst arrangement available:
 * a visual metronome is a poor thing to synchronise to — you have to be looking at it, and
 * you cannot look at it while you are dancing — and under `prefers-reduced-motion` the pulse
 * was swapped for a fade, so the people most likely to need a steady reference got the
 * weakest one.
 *
 * Sound has none of those problems. You can hear it facing away from the phone, it does not
 * compete with the demonstration for the eye, and it is what every dance class in the world
 * actually uses.
 *
 * ## Scheduled, not fired
 *
 * `setInterval` is not accurate enough for a beat. The callback drifts under load, and a
 * metronome that drifts is worse than none because the learner is being marked on timing
 * against a reference that has quietly moved. So beats are **scheduled ahead** on the audio
 * clock, which runs on its own thread and does not care what the main thread is doing: a
 * lookahead timer wakes up every 25ms and books every click due in the next 100ms.
 *
 * That is the standard Web Audio scheduling pattern, and it is the difference between a
 * metronome and an approximation.
 *
 * ## Made, not loaded
 *
 * The click is a short enveloped oscillator rather than an audio file: nothing to download,
 * nothing to cache, and no request leaves the device — which matters on a screen that has
 * already asked for the camera.
 */

export interface Metronome {
  /** Begin at the next scheduling tick. Resolves once the audio device is actually running. */
  start(): Promise<void>
  stop(): void
  /** Seconds on the audio clock since `start`, or null before it. Drives the count-in. */
  elapsed(): number | null
}

/** How often the scheduler wakes. */
const TICK_MS = 25
/** How far ahead it books. Comfortably more than one tick, so a slow wake-up cannot drop a beat. */
const LOOKAHEAD_S = 0.1

type Ctor = typeof AudioContext

function audioContext(): AudioContext | null {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  const Ctx = w.AudioContext ?? w.webkitAudioContext
  return Ctx === undefined ? null : new Ctx()
}

export interface MetronomeOptions {
  bpm: number
  /** Every nth beat is accented, so a bar has a shape. 4 for most things, 3 for a waltz. */
  perBar?: number
  /** Silent, but still ticking, so the visual beat and the count-in keep working. */
  muted?: boolean
  /** Called on the main thread as each beat lands, for anything that has to be drawn. */
  onBeat?: (beat: number) => void
}

/**
 * Build a metronome. Returns a no-op one where there is no Web Audio, rather than throwing:
 * a missing audio device is a reason to lose the click, not the dance.
 */
export function createMetronome(options: MetronomeOptions): Metronome {
  const context = audioContext()
  const secondsPerBeat = 60 / options.bpm
  const perBar = options.perBar ?? 4

  let timer: number | null = null
  let startedAt: number | null = null
  let nextBeat = 0
  let nextTime = 0

  const click = (at: number, accented: boolean): void => {
    if (context === null || options.muted === true) return

    const osc = context.createOscillator()
    const gain = context.createGain()
    osc.connect(gain)
    gain.connect(context.destination)

    // A woodblock rather than a beep: high and short. The accent is a fifth up and a shade
    // louder, which is enough to hear the top of the bar without it becoming a tune.
    osc.frequency.value = accented ? 1600 : 1050
    // An envelope, because a bare oscillator gate clicks at both ends and the click is
    // louder than the note.
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(accented ? 0.5 : 0.3, at + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06)

    osc.start(at)
    osc.stop(at + 0.08)
  }

  const schedule = (): void => {
    if (context === null) return
    while (nextTime < context.currentTime + LOOKAHEAD_S) {
      click(nextTime, nextBeat % perBar === 0)

      // The visual side is told on the main thread, at roughly the right moment. It is
      // deliberately not what the sound waits for — drawing may be late, and the click
      // must not be.
      const beat = nextBeat
      const delay = Math.max(0, (nextTime - context.currentTime) * 1000)
      window.setTimeout(() => options.onBeat?.(beat), delay)

      nextBeat += 1
      nextTime += secondsPerBeat
    }
  }

  return {
    async start(): Promise<void> {
      if (context === null) {
        startedAt = performance.now() / 1000
        return
      }
      // Autoplay policy: a context created outside a gesture starts suspended, and every
      // click would be scheduled into a clock that is not running.
      if (context.state === 'suspended') await context.resume()

      startedAt = context.currentTime
      nextBeat = 0
      nextTime = context.currentTime + 0.1
      schedule()
      timer = window.setInterval(schedule, TICK_MS)
    },

    stop(): void {
      if (timer !== null) window.clearInterval(timer)
      timer = null
      startedAt = null

      // Idempotent, because it genuinely is called twice: the effect that owns the metronome
      // stops it on teardown, and the component's unmount cleanup stops whatever is current.
      // `close()` on an already-closed context throws `InvalidStateError`, and an unhandled
      // rejection on the way out of a screen is a real error in the console for a problem
      // nobody has.
      if (context !== null && context.state !== 'closed') {
        void context.close().catch(() => undefined)
      }
    },

    elapsed(): number | null {
      if (startedAt === null) return null
      return context === null
        ? performance.now() / 1000 - startedAt
        : context.currentTime - startedAt
    },
  }
}
