/**
 * The viewfinder.
 *
 * A full-screen dialog with a live preview, a framing guide, and one still to
 * approve before anything is queued. The unhappy paths get as much room as the
 * happy one: a phone opened over plain http, a permission that was refused once
 * and is now remembered, a camera another app is holding. Each of them says what
 * happened and offers the file picker, which works everywhere the viewfinder
 * does not.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BusyIndicator, Button, Dialog, MessageStrip, Text, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/accept.js'
import '@ui5/webcomponents-icons/dist/attachment.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import '@ui5/webcomponents-icons/dist/switch-classes.js'
import { describeError } from '../../api/client'
import { useCamera } from './useCamera'

export interface CameraCaptureProps {
  open: boolean
  /** Asked for by the Cancel button, by Escape, and after a photo is accepted. */
  onClose: () => void
  onCapture: (file: File) => void
  /** The file-input path, offered wherever the live viewfinder cannot run. */
  onFallback: () => void
}

interface Shot {
  file: File
  url: string
}

export function CameraCapture({ open, onClose, onCapture, onFallback }: CameraCaptureProps) {
  const camera = useCamera()
  const { start, stop, capture, switchCamera, state, stream, error, devices } = camera

  const videoRef = useRef<HTMLVideoElement>(null)
  const [shot, setShot] = useState<Shot | null>(null)
  const [shooting, setShooting] = useState(false)
  const [shotError, setShotError] = useState<string | null>(null)

  // The live object URL, held outside state so it can be revoked from a cleanup
  // without a stale closure — and revoked *here* rather than inside a state
  // updater, which React is free to run twice.
  const shotUrlRef = useRef<string | null>(null)

  const showShot = useCallback((next: Shot | null) => {
    const previous = shotUrlRef.current
    if (previous) URL.revokeObjectURL(previous)
    shotUrlRef.current = next?.url ?? null
    setShot(next)
  }, [])

  const clearShot = useCallback(() => showShot(null), [showShot])

  /**
   * Bumped whenever the viewfinder closes. Encoding a frame takes long enough
   * to cancel during, and a still that lands after the dialog is gone would be
   * waiting, already approved-looking, the next time it opens — a photo of the
   * last receipt offered as a photo of this one.
   */
  const sessionRef = useRef(0)

  // The single cleanup path. Closing by the button, by Escape, or by unmounting
  // all end here, because all three flip `open` or tear the component down.
  useEffect(() => {
    if (!open) return
    void start()
    return () => {
      stop()
    }
  }, [open, start, stop])

  useEffect(() => {
    if (open) return
    sessionRef.current += 1
    clearShot()
    setShotError(null)
    setShooting(false)
  }, [open, clearShot])

  // Object URLs outlive the component that made them.
  useEffect(
    () => () => {
      if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current)
      shotUrlRef.current = null
    },
    [],
  )

  // Attached imperatively: `srcObject` takes an object, so it cannot be a JSX
  // attribute. `muted` is re-asserted here because iOS blanks an unmuted inline
  // video no matter what the markup said.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // React sets `muted` as a property and never writes the attribute, and iOS
    // reads the attribute when it decides whether an inline video may autoplay.
    // Both, then, and both before the stream arrives.
    video.muted = true
    video.setAttribute('muted', '')
    video.srcObject = stream
    if (stream && typeof video.play === 'function') {
      void video.play().catch(() => {
        // Autoplay was refused or interrupted. The element is `autoPlay`, so the
        // browser retries by itself once there are frames; there is nothing to
        // tell the user and nothing to undo.
      })
    }
    return () => {
      video.srcObject = null
    }
  }, [stream])

  const handleShutter = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const session = sessionRef.current
    setShooting(true)
    setShotError(null)
    void (async () => {
      try {
        const file = await capture(video)
        if (session !== sessionRef.current) return
        showShot({ file, url: URL.createObjectURL(file) })
      } catch (failure) {
        if (session !== sessionRef.current) return
        setShotError(describeError(failure))
      } finally {
        setShooting(false)
      }
    })()
  }, [capture, showShot])

  const handleRetake = useCallback(() => {
    clearShot()
    setShotError(null)
  }, [clearShot])

  const handleUse = useCallback(() => {
    if (!shot) return
    onCapture(shot.file)
    onClose()
  }, [shot, onCapture, onClose])

  const handleFallback = useCallback(() => {
    // Closed first, then the input is clicked in the same gesture — browsers
    // only open a file picker while the click is still live.
    onClose()
    onFallback()
  }, [onClose, onFallback])

  const fallbackButton = (
    <Button
      design="Transparent"
      icon="attachment"
      className="scan-camera-action"
      onClick={handleFallback}
    >
      Choose a photo instead
    </Button>
  )

  const stage = (
    <div className="scan-camera-stage" data-testid="scan-camera-stage">
      <video
        ref={videoRef}
        className="scan-camera-video"
        autoPlay
        playsInline
        muted
        data-testid="scan-camera-video"
      />
      {shot ? (
        <img
          className="scan-camera-still"
          src={shot.url}
          alt="The photo just taken"
          data-testid="scan-camera-still"
        />
      ) : (
        <>
          <div className="scan-camera-guide" aria-hidden="true" />
          <p className="scan-camera-hint">Fit the whole receipt in the frame</p>
        </>
      )}
    </div>
  )

  const liveControls = (
    <div className="scan-camera-controls">
      <div className="scan-camera-controls-start">
        <Button
          design="Transparent"
          icon="decline"
          className="scan-camera-action"
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
      <button
        type="button"
        className="scan-camera-shutter"
        onClick={handleShutter}
        disabled={shooting}
        aria-label="Capture"
        data-testid="scan-camera-shutter"
      >
        <span className="scan-camera-shutter-ring" aria-hidden="true" />
      </button>
      <div className="scan-camera-controls-end">
        {devices.length > 1 ? (
          <Button
            design="Transparent"
            icon="switch-classes"
            className="scan-camera-action"
            accessibleName="Switch camera"
            tooltip="Switch camera"
            onClick={() => {
              void switchCamera()
            }}
            data-testid="scan-camera-switch"
          />
        ) : null}
      </div>
    </div>
  )

  const shotControls = (
    <div className="scan-camera-confirm">
      <Button
        design="Transparent"
        icon="refresh"
        className="scan-camera-action scan-camera-action-grow"
        onClick={handleRetake}
      >
        Retake
      </Button>
      <Button
        design="Emphasized"
        icon="accept"
        className="scan-camera-action scan-camera-action-grow"
        onClick={handleUse}
      >
        Use this photo
      </Button>
    </div>
  )

  function pane(title: string, testId: string, copy: string, actions: ReactNode) {
    return (
      <div className="scan-camera-pane" data-testid={testId} role="alert">
        <Title level="H4">{title}</Title>
        <Text className="scan-camera-copy">{copy}</Text>
        <div className="scan-camera-pane-actions">{actions}</div>
      </div>
    )
  }

  let body: ReactNode
  if (state === 'denied') {
    body = pane(
      'Camera access is blocked',
      'scan-camera-denied',
      'This site was refused the camera, and the browser remembers that answer. Open the padlock or “aA” menu next to the address, set Camera to Allow, and reload — on iOS, check Settings › Safari › Camera as well.',
      <>
        <Button
          design="Emphasized"
          icon="refresh"
          className="scan-camera-action"
          onClick={() => {
            void start()
          }}
        >
          Try again
        </Button>
        {fallbackButton}
      </>,
    )
  } else if (state === 'unavailable') {
    body = pane(
      'No live viewfinder here',
      'scan-camera-unavailable',
      error ?? 'The camera is not available on this device.',
      fallbackButton,
    )
  } else if (state === 'error') {
    body = pane(
      'The camera did not start',
      'scan-camera-error',
      error ?? 'Something went wrong.',
      <>
        <Button
          design="Emphasized"
          icon="refresh"
          className="scan-camera-action"
          onClick={() => {
            void start()
          }}
        >
          Try again
        </Button>
        {fallbackButton}
      </>,
    )
  } else if (state === 'live') {
    body = (
      <>
        {stage}
        {shotError ? (
          <MessageStrip design="Negative" hideCloseButton className="scan-camera-strip">
            {shotError}
          </MessageStrip>
        ) : null}
        {shot ? shotControls : liveControls}
      </>
    )
  } else {
    body = (
      <div className="scan-camera-pane" data-testid="scan-camera-starting" aria-live="polite">
        <BusyIndicator active delay={0} size="M" text="Starting the camera…" />
        <div className="scan-camera-pane-actions">
          <Button
            design="Transparent"
            icon="decline"
            className="scan-camera-action"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      stretch
      headerText="Capture"
      className="scan-camera-dialog"
      data-testid="scan-camera-dialog"
      onClose={onClose}
    >
      {/* A closed UI5 dialog keeps its light DOM, so the body is dropped rather
          than hidden: no spinner animating and no <video> holding a stream
          behind a dialog nobody can see. */}
      <div className="scan-camera" data-state={state} data-testid="scan-camera">
        {open ? body : null}
      </div>
    </Dialog>
  )
}

export default CameraCapture
