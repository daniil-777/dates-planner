/**
 * The MediaStream lifecycle, owned in one place.
 *
 * Two things make in-app camera code go wrong, and both are handled here rather
 * than in the view:
 *
 *  - `getUserMedia` simply does not exist outside a secure context. This app is
 *    routinely opened on a phone as `http://192.168.x.x:5173`, where
 *    `navigator.mediaDevices` is `undefined` and touching it throws a raw
 *    TypeError. That case is detected before anything is called, and reported as
 *    `unavailable` with a reason a person can act on.
 *  - A stream that is not stopped leaves the camera light on. Every exit route —
 *    `stop()`, unmount, and the restart inside `switchCamera()` — stops every
 *    track, and the stream is held in a ref so no cleanup closure can capture a
 *    stale one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '../../api/client'
import { JPEG_QUALITY } from './constants'

export type CameraState = 'idle' | 'starting' | 'live' | 'denied' | 'unavailable' | 'error'

export type CameraFacing = 'environment' | 'user'

export interface CameraSupport {
  supported: boolean
  /** Why not, in plain language. `''` when the camera is on offer. */
  reason: string
}

export interface Camera {
  state: CameraState
  stream: MediaStream | null
  error: string | null
  /** Video inputs only — the switch button appears when there is more than one. */
  devices: MediaDeviceInfo[]
  facing: CameraFacing
  start: () => Promise<void>
  stop: () => void
  switchCamera: () => Promise<void>
  capture: (video: HTMLVideoElement) => Promise<File>
}

/** `HTMLMediaElement.HAVE_CURRENT_DATA` — the first readyState with a frame in it. */
const HAVE_CURRENT_DATA = 2

/** The camera is asked for a 1920px-wide frame; the queue's `prepareImage` caps it from there. */
const IDEAL_WIDTH = 1920

const NO_API_REASON =
  'This browser does not hand the camera to web pages. Choosing a photo still works.'

const WARMING_UP = 'The viewfinder has no frame yet. Give it a second, then try again.'

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  )
}

function mediaDevices(): MediaDevices | undefined {
  if (typeof navigator === 'undefined') return undefined
  // Widened on purpose: the DOM lib types this as always present, and on plain
  // http it is not there at all.
  const devices: MediaDevices | undefined = navigator.mediaDevices
  return devices
}

/**
 * Can this page open a camera at all? Answered without calling anything, so a
 * button can be hidden instead of failing when it is pressed.
 */
export function cameraSupport(): CameraSupport {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, reason: NO_API_REASON }
  }

  // Browsers allow the camera on https and on localhost, nowhere else. Opening
  // the dev server by LAN address is exactly the "nowhere else" case. Where the
  // flag itself is missing — jsdom, very old browsers — fall back to the rule
  // the flag encodes.
  const secure =
    typeof window.isSecureContext === 'boolean'
      ? window.isSecureContext
      : isLoopback(window.location.hostname)
  if (!secure) {
    return {
      supported: false,
      reason: `This page is open over plain http (${window.location.host}), and browsers only allow the camera on https or on localhost. Choosing a photo still works.`,
    }
  }

  const devices = mediaDevices()
  if (!devices || typeof devices.getUserMedia !== 'function') {
    return { supported: false, reason: NO_API_REASON }
  }

  return { supported: true, reason: '' }
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

function errorName(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const name = error.name
    if (typeof name === 'string') return name
  }
  return ''
}

interface Failure {
  state: 'denied' | 'unavailable' | 'error'
  message: string
}

/**
 * `getUserMedia` rejects with a DOMException whose *name* carries the meaning;
 * the message is browser prose and differs everywhere.
 */
function classifyFailure(error: unknown): Failure {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { state: 'denied', message: 'This site was refused access to the camera.' }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { state: 'unavailable', message: 'No camera was found on this device.' }
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        state: 'unavailable',
        message: 'This device has a camera, but not one that fits what the viewfinder asked for.',
      }
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        state: 'error',
        message: 'The camera is busy — another app or tab is holding it.',
      }
    default:
      return { state: 'error', message: describeError(error) }
  }
}

function encodeFrame(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null)
      return
    }
    canvas.toBlob(blob => resolve(blob), 'image/jpeg', JPEG_QUALITY)
  })
}

export function useCamera(): Camera {
  const support = useMemo(() => cameraSupport(), [])

  const [state, setState] = useState<CameraState>(support.supported ? 'idle' : 'unavailable')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(support.supported ? null : support.reason)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [facing, setFacing] = useState<CameraFacing>('environment')

  // Refs, not state: the unmount closure must see the stream that is actually
  // open, not the one that was open when the closure was created.
  const streamRef = useRef<MediaStream | null>(null)
  const facingRef = useRef<CameraFacing>('environment')
  const mountedRef = useRef(true)
  /** Bumped on every release; a slow `getUserMedia` checks it before keeping a stream. */
  const attemptRef = useRef(0)
  const shotRef = useRef(0)

  const release = useCallback(() => {
    attemptRef.current += 1
    stopTracks(streamRef.current)
    streamRef.current = null
    setStream(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current += 1
      stopTracks(streamRef.current)
      streamRef.current = null
    }
  }, [])

  const refreshDevices = useCallback(async () => {
    const md = mediaDevices()
    if (!md || typeof md.enumerateDevices !== 'function') return
    try {
      const all = await md.enumerateDevices()
      if (!mountedRef.current) return
      setDevices(all.filter(device => device.kind === 'videoinput'))
    } catch {
      // The switch button is a nicety. An unreadable device list just hides it.
    }
  }, [])

  const startWith = useCallback(
    async (next: CameraFacing) => {
      const probe = cameraSupport()
      const md = mediaDevices()
      if (!probe.supported || !md) {
        setState('unavailable')
        setError(probe.supported ? NO_API_REASON : probe.reason)
        return
      }

      // A restart always releases first: switching cameras without this leaves
      // the previous one live and the indicator light on.
      release()
      const attempt = attemptRef.current
      setState('starting')
      setError(null)

      try {
        const media = await md.getUserMedia({
          // `ideal`, not `exact`: a laptop with one front camera should still
          // open rather than fail with OverconstrainedError. `audio: false`
          // matters — asking for audio prompts for the microphone as well, for
          // a feature that has no use for it.
          video: { facingMode: { ideal: next }, width: { ideal: IDEAL_WIDTH } },
          audio: false,
        })

        if (attempt !== attemptRef.current || !mountedRef.current) {
          // Someone closed the viewfinder while the permission prompt was up.
          stopTracks(media)
          return
        }

        // Committed only now, on success. `start()` — the Try again button —
        // reads this back, so a front camera that refused to open must not
        // become the one every retry asks for; the hook outlives the dialog, so
        // that would survive closing and reopening it.
        facingRef.current = next
        setFacing(next)
        streamRef.current = media
        setStream(media)
        setState('live')
        void refreshDevices()
      } catch (failure) {
        if (attempt !== attemptRef.current || !mountedRef.current) return
        const outcome = classifyFailure(failure)
        setState(outcome.state)
        setError(outcome.message)
      }
    },
    [refreshDevices, release],
  )

  const start = useCallback(() => startWith(facingRef.current), [startWith])

  const switchCamera = useCallback(
    () => startWith(facingRef.current === 'environment' ? 'user' : 'environment'),
    [startWith],
  )

  const stop = useCallback(() => {
    release()
    setState(support.supported ? 'idle' : 'unavailable')
    setError(support.supported ? null : support.reason)
  }, [release, support])

  const capture = useCallback(async (video: HTMLVideoElement): Promise<File> => {
    if (video.readyState < HAVE_CURRENT_DATA) throw new Error(WARMING_UP)

    // The intrinsic frame, never the CSS box: the element is letterboxed and
    // `object-fit: cover`-ed, and drawing at its layout size would throw away
    // most of the receipt's resolution.
    const width = video.videoWidth
    const height = video.videoHeight
    if (width === 0 || height === 0) throw new Error(WARMING_UP)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not copy the frame out of the viewfinder.')
    context.drawImage(video, 0, 0, width, height)

    const blob = await encodeFrame(canvas)
    if (!blob) throw new Error('This browser could not encode the photo.')

    shotRef.current += 1
    // Deliberately the raw frame. Downscaling has exactly one home — the
    // `prepareImage` call the upload queue already makes on every file it is
    // given — so a photo taken here and a photo picked from the roll reach the
    // server through the same code, and neither is re-encoded twice.
    return new File([blob], `receipt-${shotRef.current}.jpg`, { type: 'image/jpeg' })
  }, [])

  return { state, stream, error, devices, facing, start, stop, switchCamera, capture }
}
