/**
 * Press-and-hold voice recording, with the waveform captured while it happens.
 *
 * ## The waveform is the point
 *
 * A voice note that arrives as a grey bar tells the person nothing until they play it.
 * Sampling the amplitude while recording costs nothing — the audio is already flowing
 * through an `AnalyserNode` — and lets the bubble draw its shape the instant it appears,
 * before a single byte of audio is fetched. That one detail is most of what makes a voice
 * message feel like WhatsApp rather than like a file attachment.
 *
 * ## Container
 *
 * Whatever the platform prefers: `audio/webm;codecs=opus` on Chrome and Android,
 * `audio/mp4` on Safari and iOS. It is stored exactly as recorded — every current browser
 * plays both, so transcoding would spend CPU to arrive at the same bytes (ADR-002 §5).
 *
 * ## Secure context
 *
 * `getUserMedia` needs HTTPS or localhost, exactly like the camera. Over plain http on a
 * LAN address `navigator.mediaDevices` is `undefined`, so this reports `unsupported`
 * rather than throwing, and the composer keeps its text box.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Roughly 40 samples a second: enough to look like speech, small enough to send. */
const PEAKS_PER_SECOND = 40
const MAX_MS = 120_000

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'denied' | 'unsupported' | 'error'

export interface Recording {
  blob: Blob
  mediaType: string
  durationMs: number
  /** Amplitudes in 0..1, one every 25 ms. */
  peaks: number[]
}

export interface VoiceRecorder {
  state: RecorderState
  error: string | null
  /** Milliseconds so far, for the counter while a finger is held down. */
  elapsedMs: number
  /** Live amplitudes, so the button can pulse with the voice. */
  peaks: number[]
  start(): Promise<void>
  /** Resolves with the recording, or null if it was cancelled or too short to mean anything. */
  stop(): Promise<Recording | null>
  cancel(): void
}

/** The first container this browser will actually record. */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate
    }
  }
  return ''
}

function canRecord(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof MediaRecorder === 'undefined') return false
  const secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : true
  return secure && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export function useVoiceRecorder(): VoiceRecorder {
  const [state, setState] = useState<RecorderState>(() => (canRecord() ? 'idle' : 'unsupported'))
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [peaks, setPeaks] = useState<number[]>([])

  // Every one of these is a ref rather than state: the cleanup path must see the current
  // value, and a stale closure holding a previous stream is how a recorder leaks a
  // microphone — the tab keeps its recording indicator on long after the UI has moved on.
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const peaksRef = useRef<number[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const sampleTimerRef = useRef<number | null>(null)
  const tickTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const cancelledRef = useRef(false)

  const release = useCallback((): void => {
    if (sampleTimerRef.current !== null) window.clearInterval(sampleTimerRef.current)
    if (tickTimerRef.current !== null) window.clearInterval(tickTimerRef.current)
    sampleTimerRef.current = null
    tickTimerRef.current = null

    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null

    void audioContextRef.current?.close().catch(() => {
      // A context closed twice throws; there is nothing useful to do about it.
    })
    audioContextRef.current = null
    recorderRef.current = null
  }, [])

  // Whatever happens to the component, the microphone is let go.
  useEffect(() => release, [release])

  const start = useCallback(async (): Promise<void> => {
    if (!canRecord()) {
      setState('unsupported')
      setError(
        window.isSecureContext === false
          ? 'Recording needs a secure connection — this page is open over plain http.'
          : 'This browser cannot record audio.',
      )
      return
    }

    setState('requesting')
    setError(null)
    cancelledRef.current = false
    chunksRef.current = []
    peaksRef.current = []
    setPeaks([])
    setElapsedMs(0)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setState('denied')
        setError('Microphone access was refused. You can allow it in the browser settings.')
      } else if (name === 'NotFoundError') {
        setState('unsupported')
        setError('No microphone was found.')
      } else {
        setState('error')
        setError('The microphone could not be opened.')
      }
      return
    }

    // The component may have gone away while the permission prompt was open. Let the
    // stream go rather than leaving a live microphone attached to nothing.
    if (cancelledRef.current) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    streamRef.current = stream

    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType === '' ? undefined : { mimeType })
    recorderRef.current = recorder
    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.start(250)

    // The analyser is only ever read for a level; 256 bins is plenty and cheap.
    const context = new AudioContext()
    audioContextRef.current = context
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    context.createMediaStreamSource(stream).connect(analyser)
    const buffer = new Uint8Array(analyser.frequencyBinCount)

    sampleTimerRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(buffer)
      // Peak deviation from the 128 midpoint, normalised. Cheaper than RMS and, for a
      // bar that is 24 pixels tall, indistinguishable from it.
      let loudest = 0
      for (const sample of buffer) {
        const level = Math.abs(sample - 128) / 128
        if (level > loudest) loudest = level
      }
      peaksRef.current.push(Math.min(1, loudest))
      // Only the tail drives the live button, so the array is not copied on every tick.
      setPeaks(peaksRef.current.slice(-48))
    }, 1000 / PEAKS_PER_SECOND)

    startedAtRef.current = Date.now()
    tickTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      if (elapsed >= MAX_MS) recorderRef.current?.stop()
    }, 100)

    setState('recording')
  }, [])

  const stop = useCallback(async (): Promise<Recording | null> => {
    const recorder = recorderRef.current
    if (recorder === null || recorder.state === 'inactive') {
      release()
      setState('idle')
      return null
    }

    const mediaType = recorder.mimeType === '' ? 'audio/webm' : recorder.mimeType
    const durationMs = Date.now() - startedAtRef.current
    const captured = [...peaksRef.current]

    const blob = await new Promise<Blob>(resolve => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: mediaType }))
      recorder.stop()
    })

    release()
    setState('idle')
    setElapsedMs(0)
    setPeaks([])

    // Under half a second is a mis-tap, not a message.
    if (cancelledRef.current || durationMs < 500 || blob.size === 0) return null
    return { blob, mediaType, durationMs, peaks: captured }
  }, [release])

  const cancel = useCallback((): void => {
    cancelledRef.current = true
    recorderRef.current?.stop()
    release()
    setState(canRecord() ? 'idle' : 'unsupported')
    setElapsedMs(0)
    setPeaks([])
  }, [release])

  return { state, error, elapsedMs, peaks, start, stop, cancel }
}
