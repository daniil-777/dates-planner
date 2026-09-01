/**
 * The viewfinder's own logic, not the browser's.
 *
 * jsdom has no `getUserMedia`, no `MediaStream` and no canvas, which is a fair
 * imitation of the two environments this feature actually has to survive: a
 * phone opened over plain http, where the API is absent, and a browser that has
 * been told once to refuse the camera. Both are stubbed here; what is asserted
 * is our reaction to them — and, above all, that every track is stopped on the
 * way out, because a leaked track leaves the phone's camera light on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CameraCapture } from './CameraCapture'
import { CaptureCard } from './CaptureCard'

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>

interface FakeTrack {
  kind: string
  stop: ReturnType<typeof vi.fn>
}

/** A stream whose tracks record whether anybody bothered to stop them. */
function fakeStream(count = 2): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = Array.from({ length: count }, (_unused, index) => ({
    kind: index === 0 ? 'video' : 'audio',
    stop: vi.fn(),
  }))
  const stream = { getTracks: () => tracks } as unknown as MediaStream
  return { stream, tracks }
}

function videoInputs(count: number): MediaDeviceInfo[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        deviceId: `video-${index}`,
        groupId: `group-${index}`,
        kind: 'videoinput',
        label: `Camera ${index}`,
      }) as MediaDeviceInfo,
  )
}

function stubMediaDevices(getUserMedia: GetUserMedia, cameras = 1): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => videoInputs(cameras)),
    },
  })
}

/** `open` lives in a parent, exactly as it does in CaptureCard. */
function Viewfinder(props: { onCapture?: (file: File) => void; onFallback?: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      {/* The viewfinder is mounted for the life of the page and reopened, which
          is what CaptureCard does — so the hook's state has to survive a close. */}
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      <CameraCapture
        open={open}
        onClose={() => setOpen(false)}
        onCapture={props.onCapture ?? (() => {})}
        onFallback={props.onFallback ?? (() => {})}
      />
    </>
  )
}

/** A `getUserMedia` whose promise this test decides when to settle. */
function deferredMedia(): { getUserMedia: GetUserMedia; resolve: (s: MediaStream) => void } {
  let resolve: (s: MediaStream) => void = () => {}
  const getUserMedia: GetUserMedia = () => new Promise<MediaStream>(r => (resolve = r))
  return { getUserMedia, resolve: stream => resolve(stream) }
}

function liveVideo(element: HTMLElement, width: number, height: number, readyState = 4): void {
  Object.defineProperty(element, 'readyState', { configurable: true, value: readyState })
  Object.defineProperty(element, 'videoWidth', { configurable: true, value: width })
  Object.defineProperty(element, 'videoHeight', { configurable: true, value: height })
}

/** Canvas sizes, in creation order, so the capture frame can be checked. */
const canvasSizes: Array<[number, number]> = []
const realGetContext = HTMLCanvasElement.prototype.getContext

function recordingGetContext(this: HTMLCanvasElement): CanvasRenderingContext2D {
  canvasSizes.push([this.width, this.height])
  return { drawImage: () => {} } as unknown as CanvasRenderingContext2D
}

beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:shot')
  globalThis.URL.revokeObjectURL = vi.fn()
  // Present so that a capture path which started decoding its own frame again
  // would show up as an extra canvas rather than as a hung test.
  globalThis.createImageBitmap = vi.fn(
    async () => ({ width: 1200, height: 1600, close: () => {} }) as unknown as ImageBitmap,
  )
  // jsdom's HTMLMediaElement.play only logs "not implemented" noise.
  HTMLMediaElement.prototype.play = vi.fn(async () => {})
  HTMLCanvasElement.prototype.getContext =
    recordingGetContext as unknown as typeof HTMLCanvasElement.prototype.getContext
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext
})

beforeEach(() => {
  canvasSizes.length = 0
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Reflect.deleteProperty(window, 'isSecureContext')
})

describe('CameraCapture — when the camera cannot be opened at all', () => {
  it('explains itself instead of showing a broken viewfinder when there is no camera API', async () => {
    // jsdom ships no navigator.mediaDevices, which is exactly what a browser
    // does when the page is not allowed to ask for a camera.
    render(<Viewfinder />)

    expect(await screen.findByTestId('scan-camera-unavailable')).toBeInTheDocument()
    expect(screen.getByText('No live viewfinder here')).toBeInTheDocument()
    // The fallback is offered, not just described.
    expect(screen.getByText('Choose a photo instead')).toBeInTheDocument()
    // No dead <video> element behind the message.
    expect(screen.queryByTestId('scan-camera-video')).not.toBeInTheDocument()
    expect(screen.queryByTestId('scan-camera-shutter')).not.toBeInTheDocument()
  })

  it('names plain http as the reason when the page is not in a secure context', async () => {
    // How this app is opened on a phone today: http://<lan-ip>:5173.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })

    render(<Viewfinder />)

    expect(await screen.findByTestId('scan-camera-unavailable')).toBeInTheDocument()
    expect(
      screen.getByText(/browsers only allow the camera on https or on localhost/i),
    ).toBeInTheDocument()
    expect(screen.getByText('Choose a photo instead')).toBeInTheDocument()
  })

  it('offers the file-input fallback and closes when it is taken', async () => {
    const onFallback = vi.fn()
    render(<Viewfinder onFallback={onFallback} />)

    fireEvent.click(await screen.findByText('Choose a photo instead'))

    expect(onFallback).toHaveBeenCalledTimes(1)
    // The dialog gets out of the way first, so the file picker it opens is not
    // trapped behind a modal.
    await waitFor(() =>
      expect(screen.getByTestId('scan-camera-dialog')).not.toHaveAttribute('open'),
    )
  })
})

describe('CameraCapture — when permission is refused', () => {
  it('reads NotAllowedError as denied and says how to undo it', async () => {
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
    stubMediaDevices(getUserMedia)

    render(<Viewfinder />)

    expect(await screen.findByTestId('scan-camera-denied')).toBeInTheDocument()
    expect(screen.getByText('Camera access is blocked')).toBeInTheDocument()
    expect(screen.getByText(/set Camera to Allow/i)).toBeInTheDocument()
    // A refusal is not a dead end.
    expect(screen.getByText('Try again')).toBeInTheDocument()
    expect(screen.getByText('Choose a photo instead')).toBeInTheDocument()
  })

  it('never asks for the microphone, and asks the rear camera for a 1920px frame', async () => {
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
    stubMediaDevices(getUserMedia)

    render(<Viewfinder />)
    await screen.findByTestId('scan-camera-denied')

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    })
  })

  it('reads NotFoundError as unavailable rather than as a failure', async () => {
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockRejectedValue(new DOMException('No camera', 'NotFoundError'))
    stubMediaDevices(getUserMedia)

    render(<Viewfinder />)

    expect(await screen.findByTestId('scan-camera-unavailable')).toBeInTheDocument()
    expect(screen.getByText('No camera was found on this device.')).toBeInTheDocument()
  })

  it('reads anything else as an error worth retrying', async () => {
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockRejectedValue(new DOMException('Camera in use', 'NotReadableError'))
    stubMediaDevices(getUserMedia)

    render(<Viewfinder />)

    expect(await screen.findByTestId('scan-camera-error')).toBeInTheDocument()
    expect(screen.getByText('The camera did not start')).toBeInTheDocument()
    expect(screen.getByText('Try again')).toBeInTheDocument()
  })
})

describe('CameraCapture — the stream', () => {
  it('stops every track when the dialog is closed by its own button', async () => {
    const { stream, tracks } = fakeStream(2)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))

    render(<Viewfinder />)
    await screen.findByTestId('scan-camera-shutter')
    for (const track of tracks) expect(track.stop).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => {
      for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    })
  })

  it('stops every track when the viewfinder is torn down without being closed', async () => {
    const { stream, tracks } = fakeStream(2)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))

    const view = render(<Viewfinder />)
    await screen.findByTestId('scan-camera-shutter')

    view.unmount()

    // Exactly once: the two cleanup paths must not double-stop, and neither may
    // skip a track because it read a stale stream out of a closure.
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('releases the open camera before switching to the other one', async () => {
    const first = fakeStream(1)
    const second = fakeStream(1)
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream)
    stubMediaDevices(getUserMedia, 2)

    render(<Viewfinder />)
    // The switch button only exists because enumerateDevices reported two inputs.
    const switchButton = await screen.findByTestId('scan-camera-switch')

    fireEvent.click(switchButton)

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1920 } },
      audio: false,
    })
  })

  it('hides the switch button when the device has only one camera', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream), 1)
    // Asserting "not there" is only worth anything after the device list has
    // actually been read; before that it is not there for the wrong reason.
    const enumerate = navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>

    render(<Viewfinder />)
    await screen.findByTestId('scan-camera-shutter')
    await waitFor(() => expect(enumerate).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByTestId('scan-camera-shutter')).toHaveLength(1))

    expect(screen.queryByTestId('scan-camera-switch')).toBeNull()
  })

  it('stops every track when the photo is accepted', async () => {
    const { stream, tracks } = fakeStream(2)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onCapture = vi.fn<(file: File) => void>()

    render(<Viewfinder onCapture={onCapture} />)
    liveVideo(await screen.findByTestId('scan-camera-video'), 1440, 1920)

    fireEvent.click(screen.getByTestId('scan-camera-shutter'))
    await screen.findByTestId('scan-camera-still')
    // Still live while the photo is being approved — Retake has to be instant.
    for (const track of tracks) expect(track.stop).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Use this photo'))

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1))
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the stream that arrives after the viewfinder is gone', async () => {
    // The permission prompt is modal and slow; the user can close the dialog
    // while it is still up, and the stream then resolves into a dead component.
    const { stream, tracks } = fakeStream(2)
    const deferred = deferredMedia()
    stubMediaDevices(deferred.getUserMedia)

    const view = render(<Viewfinder />)
    await screen.findByTestId('scan-camera-starting')

    view.unmount()
    await act(async () => {
      deferred.resolve(stream)
      await Promise.resolve()
    })

    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the stream that arrives after the dialog was cancelled, and starts a fresh one on reopen', async () => {
    const late = fakeStream(2)
    const second = fakeStream(2)
    let settle: (stream: MediaStream) => void = () => {}
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockImplementationOnce(() => new Promise<MediaStream>(resolve => (settle = resolve)))
      .mockResolvedValueOnce(second.stream)
    stubMediaDevices(getUserMedia)

    render(<Viewfinder />)
    await screen.findByTestId('scan-camera-starting')
    fireEvent.click(screen.getByText('Cancel'))

    await act(async () => {
      settle(late.stream)
      await Promise.resolve()
    })
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('reopen'))

    await screen.findByTestId('scan-camera-shutter')
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    // The abandoned stream is not resurrected as the live one.
    for (const track of late.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    for (const track of second.tracks) expect(track.stop).not.toHaveBeenCalled()
  })

  it('leaks nothing when StrictMode runs the effects twice', async () => {
    // React 19 in development mounts, unmounts and remounts every effect. Two
    // getUserMedia calls therefore happen, and the first stream has no view left
    // to belong to: it must be stopped, not forgotten.
    const first = fakeStream(2)
    const second = fakeStream(2)
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream)
    stubMediaDevices(getUserMedia)

    const view = render(
      <StrictMode>
        <Viewfinder />
      </StrictMode>,
    )
    await screen.findByTestId('scan-camera-shutter')

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    for (const track of second.tracks) expect(track.stop).not.toHaveBeenCalled()

    view.unmount()

    for (const track of first.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    for (const track of second.tracks) expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('does not strand the viewfinder on a camera that refused to open', async () => {
    // Switching to a front camera another app is holding must not make that the
    // camera every retry asks for — the hook outlives the dialog, so it would
    // stay broken through a close and reopen.
    const rear = fakeStream(1)
    const rearAgain = fakeStream(1)
    const getUserMedia = vi
      .fn<GetUserMedia>()
      .mockResolvedValueOnce(rear.stream)
      .mockRejectedValueOnce(new DOMException('Camera in use', 'NotReadableError'))
      .mockResolvedValueOnce(rearAgain.stream)
    stubMediaDevices(getUserMedia, 2)

    render(<Viewfinder />)
    fireEvent.click(await screen.findByTestId('scan-camera-switch'))

    await screen.findByTestId('scan-camera-error')
    fireEvent.click(screen.getByText('Try again'))

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3))
    expect(getUserMedia).toHaveBeenLastCalledWith({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    })
    await screen.findByTestId('scan-camera-shutter')
  })

  it('feeds the video by srcObject, muted and inline, the way iOS requires', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))

    render(<Viewfinder />)
    const video = await screen.findByTestId('scan-camera-video')

    expect(video).toBeInstanceOf(HTMLVideoElement)
    const element = video as HTMLVideoElement
    // A MediaStream cannot go through `src`; iOS blanks an unmuted or
    // full-screen-ing inline video outright.
    expect(element.srcObject).toBe(stream)
    expect(element.getAttribute('src')).toBeNull()
    expect(element.muted).toBe(true)
    expect(element).toHaveAttribute('muted')
    expect(element).toHaveAttribute('playsinline')
    expect(element).toHaveAttribute('autoplay')
  })
})

describe('CameraCapture — taking the photo', () => {
  it('draws the intrinsic frame and hands one prepared jpeg to the queue', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onCapture = vi.fn<(file: File) => void>()

    render(<Viewfinder onCapture={onCapture} />)
    const video = await screen.findByTestId('scan-camera-video')
    // The CSS box is 0×0 in jsdom; these are the numbers that must be used.
    liveVideo(video, 1440, 1920)

    fireEvent.click(screen.getByTestId('scan-camera-shutter'))

    // The still is shown for approval; nothing is queued yet.
    expect(await screen.findByTestId('scan-camera-still')).toBeInTheDocument()
    expect(onCapture).not.toHaveBeenCalled()
    // Exactly one canvas: the frame is encoded once here and normalised once by
    // the queue's own prepareImage. A second canvas would mean a second
    // generation of q85 loss for nothing.
    expect(canvasSizes).toEqual([[1440, 1920]])

    fireEvent.click(screen.getByText('Use this photo'))

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1))
    const file = onCapture.mock.calls[0][0]
    expect(file.name).toBe('receipt-1.jpg')
    expect(file.type).toBe('image/jpeg')
  })

  it('goes back to the viewfinder on Retake without queueing anything', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onCapture = vi.fn<(file: File) => void>()

    render(<Viewfinder onCapture={onCapture} />)
    liveVideo(await screen.findByTestId('scan-camera-video'), 1440, 1920)

    fireEvent.click(screen.getByTestId('scan-camera-shutter'))
    await screen.findByTestId('scan-camera-still')

    fireEvent.click(screen.getByText('Retake'))

    await waitFor(() => expect(screen.queryByTestId('scan-camera-still')).toBeNull())
    expect(screen.getByTestId('scan-camera-shutter')).toBeInTheDocument()
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('throws away a still that lands after the viewfinder was closed', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onCapture = vi.fn<(file: File) => void>()

    render(<Viewfinder onCapture={onCapture} />)
    liveVideo(await screen.findByTestId('scan-camera-video'), 1440, 1920)

    // Cancelled while the frame is still being encoded.
    fireEvent.click(screen.getByTestId('scan-camera-shutter'))
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() =>
      expect(screen.getByTestId('scan-camera-dialog')).not.toHaveAttribute('open'),
    )

    fireEvent.click(screen.getByTestId('reopen'))
    await screen.findByTestId('scan-camera-shutter')

    // The next receipt must not open on a picture of the last one, pre-approved.
    expect(screen.queryByTestId('scan-camera-still')).toBeNull()
    expect(screen.queryByText('Use this photo')).toBeNull()
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('refuses to capture a frame the video does not have yet', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onCapture = vi.fn<(file: File) => void>()

    render(<Viewfinder onCapture={onCapture} />)
    // readyState 0: the stream is attached but no frame has arrived.
    liveVideo(await screen.findByTestId('scan-camera-video'), 0, 0, 0)

    fireEvent.click(screen.getByTestId('scan-camera-shutter'))

    expect(await screen.findByText(/no frame yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId('scan-camera-still')).toBeNull()
    expect(onCapture).not.toHaveBeenCalled()
    expect(canvasSizes).toHaveLength(0)
  })
})

describe('CaptureCard — the viewfinder in its place', () => {
  it('hands the captured photo to the same queue entry point the file inputs use', async () => {
    const { stream, tracks } = fakeStream(2)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onFiles = vi.fn<(files: File[]) => void>()

    render(<CaptureCard onFiles={onFiles} onManual={() => {}} busy={false} />)
    fireEvent.click(await screen.findByTestId('scan-open-camera'))
    liveVideo(await screen.findByTestId('scan-camera-video'), 1440, 1920)

    fireEvent.click(screen.getByTestId('scan-camera-shutter'))
    await screen.findByTestId('scan-camera-still')
    fireEvent.click(screen.getByText('Use this photo'))

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1))
    const [files] = onFiles.mock.calls[0]
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].name).toBe('receipt-1.jpg')
    expect(files[0].type).toBe('image/jpeg')
    // And the dialog let go of the camera on its way out.
    await waitFor(() => {
      for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1)
    })
  })

  it('leaves the capture=environment input exactly as it was', async () => {
    const { stream } = fakeStream(1)
    stubMediaDevices(vi.fn<GetUserMedia>().mockResolvedValue(stream))
    const onFiles = vi.fn<(files: File[]) => void>()

    render(<CaptureCard onFiles={onFiles} onManual={() => {}} busy={false} />)

    // The only path that works on a phone over plain http. It is not allowed to
    // change because something prettier was added next to it.
    const input = screen.getByTestId('scan-camera-input')
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveAttribute('accept', 'image/*')
    expect(input).toHaveAttribute('capture', 'environment')
    expect(input).toHaveAttribute('multiple')
    expect(screen.getByText('Scan receipt')).toBeInTheDocument()

    const file = new File([new Uint8Array([0xff, 0xd8])], 'till.jpg', { type: 'image/jpeg' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(onFiles).toHaveBeenCalledWith([file])
  })

  it('hides the camera button and says why when the page cannot have one', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })

    render(<CaptureCard onFiles={() => {}} onManual={() => {}} busy={false} />)

    expect(screen.queryByTestId('scan-open-camera')).toBeNull()
    expect(screen.getByTestId('scan-camera-note')).toHaveTextContent(
      /browsers only allow the camera on https or on localhost/i,
    )
    // The way in is still there, and still first.
    expect(screen.getByText('Scan receipt')).toBeInTheDocument()
  })
})
