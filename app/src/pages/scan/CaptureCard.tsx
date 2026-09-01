import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Button, Text } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/camera.js'
import '@ui5/webcomponents-icons/dist/add-photo.js'
import '@ui5/webcomponents-icons/dist/attachment.js'
import '@ui5/webcomponents-icons/dist/edit.js'
import { EmptyState } from '../../components/EmptyState'
import { CameraCapture } from './CameraCapture'
import { isImageFile } from './imageProcessing'
import { cameraSupport } from './useCamera'

interface CaptureCardProps {
  onFiles: (files: File[]) => void
  onManual: () => void
  /** True while the queue is still working; new picks are queued behind it. */
  busy: boolean
  /** Shown instead of the hero once at least one receipt has been scanned. */
  compact?: boolean
}

/**
 * The front door: the in-app viewfinder first, then the phone's own camera app,
 * then the file picker, then a way in for the receipt that was thrown away.
 *
 * The three file-input paths are not decoration. They work over plain http, in
 * every browser, and with no permission prompt, which is why they stay exactly
 * where they were when the viewfinder cannot run.
 */
export function CaptureCard({ onFiles, onManual, busy, compact = false }: CaptureCardProps) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const [viewfinderOpen, setViewfinderOpen] = useState(false)

  // A pure probe — it opens nothing, prompts for nothing, and touches no
  // hardware. It only answers "could this page have a viewfinder at all?", so
  // the button is hidden rather than dead where the answer is no.
  const support = useMemo(() => cameraSupport(), [])
  const liveCapture = support.supported

  const handlePicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []).filter(isImageFile)
      // Reset so picking the very same photo twice still fires a change event.
      event.target.value = ''
      if (picked.length > 0) onFiles(picked)
    },
    [onFiles],
  )

  // The viewfinder hands its photo to the same queue the file inputs feed, so
  // scanning, classifying and confirming are identical either way.
  const handleCaptured = useCallback((file: File) => onFiles([file]), [onFiles])

  const openDeviceCamera = useCallback(() => cameraRef.current?.click(), [])

  const inputs = (
    <>
      <input
        ref={cameraRef}
        className="scan-hidden-input"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-testid="scan-camera-input"
        onChange={handlePicked}
      />
      <input
        ref={filesRef}
        className="scan-hidden-input"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-testid="scan-file-input"
        onChange={handlePicked}
      />
    </>
  )

  // Not rendered at all where it could never open: no dialog in the DOM and no
  // MediaStream lifecycle standing by for a button that is not there.
  const viewfinder = liveCapture ? (
    <CameraCapture
      open={viewfinderOpen}
      onClose={() => setViewfinderOpen(false)}
      onCapture={handleCaptured}
      onFallback={openDeviceCamera}
    />
  ) : null

  const actions = (
    <div className="scan-capture" data-testid="scan-capture-actions">
      {liveCapture ? (
        <Button
          className="scan-capture-primary"
          design="Emphasized"
          icon="camera"
          accessibleName="Open the camera and photograph a receipt"
          onClick={() => setViewfinderOpen(true)}
          data-testid="scan-open-camera"
        >
          Open camera
        </Button>
      ) : null}
      <Button
        className={liveCapture ? 'scan-capture-secondary' : 'scan-capture-primary'}
        design={liveCapture ? 'Transparent' : 'Emphasized'}
        icon={liveCapture ? 'add-photo' : 'camera'}
        accessibleName="Scan a receipt with the camera"
        onClick={openDeviceCamera}
      >
        Scan receipt
      </Button>
      <Button
        className="scan-capture-secondary"
        design="Transparent"
        icon="attachment"
        accessibleName="Choose receipt photos from this device"
        onClick={() => filesRef.current?.click()}
      >
        Choose photos
      </Button>
      <Button
        className="scan-capture-secondary"
        design="Transparent"
        icon="edit"
        accessibleName="Post an expense without a receipt"
        onClick={onManual}
      >
        Enter manually
      </Button>
    </div>
  )

  const cameraNote = liveCapture ? null : (
    <Text className="scan-hint" data-testid="scan-camera-note">
      {support.reason}
    </Text>
  )

  if (compact) {
    return (
      <div className="scan-capture-block" data-testid="scan-capture-compact">
        {inputs}
        {viewfinder}
        {actions}
        {cameraNote}
      </div>
    )
  }

  return (
    <div data-testid="scan-capture">
      {inputs}
      {viewfinder}
      <EmptyState
        icon="receipt"
        title="Nothing posted yet"
        description={
          busy
            ? 'Your receipts are being read. Add more while you wait — they queue up.'
            : 'Photograph a receipt and it comes back as a draft document: merchant, date, amount, category. You confirm; the ledger posts it.'
        }
        action={actions}
      />
      {cameraNote}
      <Text className="scan-hint">
        Photos are downscaled on this device before upload — 2000 px long edge, JPEG q85. Select
        several at once to post a stack in one sitting.
      </Text>
    </div>
  )
}
