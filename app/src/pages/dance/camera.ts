/**
 * The camera, and the pose detector behind it.
 *
 * ## The privacy rule, which is the first thing here for a reason
 *
 * **No frame ever leaves the device.** The detector is WebAssembly running in this browser;
 * there is no upload, no inference API, no "just for debugging" endpoint. What is kept from
 * a session is a score and a sentence — never the video, and never the landmarks either.
 *
 * Landmarks deserve their own line, because they look harmless and are not: a time series of
 * somebody's joint positions is a gait signature, and gait identifies people about as well as
 * a face does. This app holds a touch map it refuses to send to a model (CONTRACTS §13.4);
 * it is not going to keep a biometric because the biometric happened to arrive as numbers.
 * They exist in memory for the length of one attempt and are dropped.
 *
 * ## What is possible here, and what is not
 *
 * Apple's own pose APIs — Vision's `VNDetectHumanBodyPoseRequest`, ARKit body tracking — are
 * **native only**. A web app cannot call them, and no amount of PWA installation changes
 * that. So this is not "iPhone pose scanning"; it is pose detection in a browser, which is a
 * different implementation of the same idea and, usefully, works on Android and a laptop too.
 *
 * MediaPipe's Pose Landmarker: 33 landmarks, image space and metric world space, WASM with a
 * GPU delegate where the browser offers one.
 *
 * ## Detection blocks, and this runs on the main thread anyway
 *
 * `detectForVideo()` is **synchronous and blocks the calling thread** — documented, not
 * incidental. The textbook answer is a worker, and it is not taken here, so the reason is
 * worth writing down rather than discovering later.
 *
 * A worker cannot be handed a `<video>` element. Feeding one means grabbing each frame into
 * an `ImageBitmap` and transferring it, which adds a copy per frame and a second timing
 * domain to a feature whose entire job is measuring timing. Against that, the `lite` model
 * costs a handful of milliseconds per frame at 20 fps — real, but far short of a stalled
 * frame — and the screen during capture is deliberately almost static: a preview, a ring and
 * a beat dot, no layout, nothing that a few milliseconds of jitter would show up in.
 *
 * So: main thread, sampled against a real clock so that a slow device produces a *shorter*
 * capture rather than a stretched one. If the heavier models are ever wanted, that is the
 * point at which this has to become a worker — and `capture()` is the only function that
 * would change.
 *
 * ## Where the model comes from
 *
 * A CDN, and that is a deliberate trade rather than an oversight. The WASM runtime and the
 * model together are several megabytes; bundling them would put that into the install of
 * every household that never opens this chapter. The CDN sees a request for a file — no
 * video, no landmarks, no identity — which is the same exposure as loading a font.
 */
import type { Landmarks } from './pose'

/** Pinned. An unpinned model is a routine that silently rescores itself one morning. */
const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

/**
 * `lite` rather than `full` or `heavy`.
 *
 * The heavier models are more accurate about fingers and faces, which this app discards
 * anyway (`pose.ts` keeps twelve joint angles). What they cost is frame rate on a mid-range
 * phone, and a dance coach that runs at eight frames a second cannot measure timing — which
 * is the one thing it is for. Accuracy the feature cannot use, traded for the responsiveness
 * it needs.
 */

/** The rate the reference is sampled at, and the rate the camera is read at. */
export const FPS = 20

export interface Capture {
  /** Landmarks per frame, in order. Frames where nobody was found are omitted. */
  frames: Landmarks[]
  /** How many frames the detector was asked for, so a poor capture can be reported. */
  attempted: number
}

export class CameraError extends Error {
  constructor(
    message: string,
    /** Written for a person. */
    readonly safeMessage: string,
  ) {
    super(message)
    this.name = 'CameraError'
  }
}

/**
 * Ask for the camera.
 *
 * Front-facing, because somebody dancing needs to see themselves — a rear camera means
 * dancing away from your own phone, which nobody does twice. Modest resolution on purpose:
 * the detector downsamples anyway, and a 1080p stream costs battery and heat for nothing.
 */
export async function openCamera(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    throw new CameraError(
      'getUserMedia unavailable',
      'This browser will not give a web app the camera. Safari and Chrome both will, over https.',
    )
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    })
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : ''
    // Told apart because the fixes are different and neither is "try again".
    if (name === 'NotAllowedError') {
      throw new CameraError(
        'permission denied',
        'The camera was not allowed. You can turn it back on in your browser’s settings for this site.',
      )
    }
    if (name === 'NotFoundError') {
      throw new CameraError('no camera', 'No camera was found on this device.')
    }
    throw new CameraError(String(cause), 'The camera could not be started.')
  }
}

interface Landmarker {
  detectForVideo(video: HTMLVideoElement, timestamp: number): { worldLandmarks?: unknown[][] }
  close(): void
}

let cached: Promise<Landmarker> | null = null

/**
 * Load the detector once.
 *
 * Cached because construction downloads several megabytes and compiles WASM, and a person
 * trying four routines in a row should pay for that once. Dropped only when the page goes.
 */
export async function loadLandmarker(): Promise<Landmarker> {
  if (cached !== null) return cached

  cached = (async () => {
    // Imported here rather than at the top of the module so the whole thing is absent from
    // the bundle of somebody who never opens this chapter.
    const vision = await import('@mediapipe/tasks-vision')
    const files = await vision.FilesetResolver.forVisionTasks(WASM_ROOT)

    return (await vision.PoseLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: MODEL,
        // GPU where there is one. The delegate falls back on its own if not.
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      // One dancer. Asking for more costs time and invites the detector to lock onto
      // somebody walking through the kitchen.
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })) as unknown as Landmarker
  })().catch(error => {
    // Not cached on failure, so a flaky network does not permanently disable the chapter.
    cached = null
    throw new CameraError(
      String(error),
      'The movement detector could not be downloaded. It needs a connection the first time.',
    )
  })

  return cached
}

function toLandmarks(raw: unknown): Landmarks | null {
  if (!Array.isArray(raw) || raw.length < 29) return null
  return raw.map(point => {
    const one = (point ?? {}) as Record<string, unknown>
    return {
      x: Number(one.x ?? 0),
      y: Number(one.y ?? 0),
      z: Number(one.z ?? 0),
      // The world landmarks carry no `visibility` in some builds; a missing one is treated
      // as seen, because the alternative is discarding every frame.
      visibility: one.visibility === undefined ? 1 : Number(one.visibility),
    }
  })
}

/**
 * Read the camera for `seconds`, returning what was seen.
 *
 * Driven by `requestAnimationFrame` against a clock rather than by a fixed interval, for the
 * same reason the quiz timer is: a phone that throttles or drops frames must produce a
 * shorter capture, not a stretched one. Timing is the thing being measured, so the clock has
 * to be real.
 */
export async function capture(
  video: HTMLVideoElement,
  seconds: number,
  onFrame?: (landmarks: Landmarks | null, through: number) => void,
): Promise<Capture> {
  const landmarker = await loadLandmarker()
  const frames: Landmarks[] = []
  const started = performance.now()
  const step = 1000 / FPS
  let attempted = 0
  let next = started

  return new Promise<Capture>(resolve => {
    const tick = (): void => {
      const now = performance.now()
      const through = (now - started) / (seconds * 1000)

      if (through >= 1) {
        resolve({ frames, attempted })
        return
      }

      if (now >= next) {
        next += step
        // If the tab stalled, skip the frames that should have happened rather than
        // running them all now — a burst of stale frames would corrupt the timing.
        if (next < now) next = now + step

        attempted += 1
        try {
          const result = landmarker.detectForVideo(video, now)
          const found = result.worldLandmarks?.[0]
          const landmarks = toLandmarks(found)
          if (landmarks !== null) frames.push(landmarks)
          onFrame?.(landmarks, through)
        } catch {
          // One bad frame is not a failed attempt. The detector occasionally throws while
          // the video element is between states, and dropping the frame is the whole fix.
          onFrame?.(null, through)
        }
      }

      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })
}

/** Stop every track. Forgetting this leaves the camera light on, which people notice. */
export function closeCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach(track => track.stop())
}
