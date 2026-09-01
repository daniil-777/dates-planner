import { useMemo, useRef, useState } from 'react'
import { Button, Icon, MessageStrip, Text } from '@ui5/webcomponents-react'
import { api, describeError } from '@/api/client'
import { useAddEventPhoto, useDeleteEventPhoto } from '@/api/hooks'
import type { Event, EventPhoto } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import './icons'
import { PhotoLightbox } from './PhotoLightbox'
import { formatDay } from './dates'
import {
  MAX_PHOTOS_PER_UPLOAD,
  formatBytes,
  isImageFile,
  isPastEvent,
  photoAlt,
  photoCountLabel,
  photoInvitation,
  prepareEventPhoto,
  savePhotoDetails,
  sortPhotos,
  type PhotoDetails,
} from './photos'

export interface PhotoGalleryProps {
  event: Event
  /** Re-read the event after a write the mutation hooks do not invalidate for us. */
  onRefresh: () => void
}

interface UploadProgress {
  done: number
  total: number
}

/**
 * The pictures from an event.
 *
 * The one piece of real design here is what a *finished* event with no photographs gets.
 * A bare "No photos" is a report on an absence; this shows an invitation with the place in
 * it — "Add the photos from Lisboa" — because that is the moment the feature exists for.
 * The trip is over, the receipts are all posted, and the only thing left to file is the part
 * anybody will actually want to look at in a year.
 *
 * Uploads run one file at a time on purpose. A picked folder of holiday pictures would
 * otherwise open twenty parallel requests carrying a megabyte each, and one failure in the
 * middle of that is unattributable; sequentially, the count on screen is honest and a file
 * that fails can be named.
 */
export function PhotoGallery({ event, onRefresh }: PhotoGalleryProps) {
  const addPhoto = useAddEventPhoto()
  const deletePhoto = useDeleteEventPhoto()

  const fileInput = useRef<HTMLInputElement | null>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<EventPhoto | null>(null)
  const [deleting, setDeleting] = useState(false)

  const photos = useMemo(() => sortPhotos(event.photos ?? []), [event.photos])
  const openIndex = openId === null ? -1 : photos.findIndex(photo => photo.ID === openId)
  const past = isPastEvent(event)
  const busy = progress !== null

  const pickFiles = () => fileInput.current?.click()

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const picked = Array.from(fileList)
    const images = picked.filter(isImageFile)
    const files = images.slice(0, MAX_PHOTOS_PER_UPLOAD)

    const skipped: string[] = []
    if (images.length < picked.length) {
      const notImages = picked.length - images.length
      skipped.push(`${notImages} ${notImages === 1 ? 'file was' : 'files were'} not a picture`)
    }
    if (images.length > files.length) {
      skipped.push(`${images.length - files.length} did not fit in one go`)
    }

    setProblem(null)
    setNotice(null)
    setProgress({ done: 0, total: files.length })

    const failed: string[] = []
    let added = 0
    let uploaded = 0
    for (const [position, file] of files.entries()) {
      try {
        const prepared = await prepareEventPhoto(file)
        await addPhoto.mutateAsync({
          eventId: event.ID,
          file: prepared.blob,
          fileName: prepared.fileName,
        })
        added += 1
        uploaded += prepared.bytes
      } catch (error) {
        failed.push(`“${file.name || 'one picture'}” — ${describeError(error)}`)
      }
      setProgress({ done: position + 1, total: files.length })
    }

    setProgress(null)
    // Clearing the input matters: picking the same file twice in a row fires no change event
    // otherwise, and the second attempt looks like the app ignoring the tap.
    if (fileInput.current) fileInput.current.value = ''

    if (added > 0) {
      const parts = [
        `${added} ${added === 1 ? 'photo' : 'photos'} added, ${formatBytes(uploaded)} in all.`,
        ...skipped,
      ]
      setNotice(parts.join(' ').trim())
      onRefresh()
    } else if (failed.length === 0 && skipped.length > 0) {
      setNotice(`Nothing was added: ${skipped.join(', ')}.`)
    }
    if (failed.length > 0) setProblem(failed.join(' · '))
  }

  const handleSaveDetails = async (photoId: string, details: PhotoDetails) => {
    await savePhotoDetails(photoId, details)
    // A caption is not an event mutation, so nothing invalidates the query for us.
    onRefresh()
  }

  const handleDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setDeleting(true)
    try {
      await deletePhoto.mutateAsync(target.ID)
      // Step to the neighbour rather than dropping the viewer: deleting three duds in a row
      // should not mean reopening the album three times.
      const position = photos.findIndex(photo => photo.ID === target.ID)
      const next = photos[position + 1] ?? photos[position - 1] ?? null
      if (openId === target.ID) setOpenId(next ? next.ID : null)
      setNotice('Photo deleted.')
      onRefresh()
    } catch (error) {
      setProblem(describeError(error))
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  const addButton = (
    <Button
      design={photos.length === 0 && past ? 'Emphasized' : 'Transparent'}
      icon="add-photo"
      disabled={busy}
      data-testid="add-photos"
      onClick={pickFiles}
    >
      {busy
        ? `Uploading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
        : 'Add photos'}
    </Button>
  )

  return (
    <section className="ev-panel" aria-label="Photographs from this event">
      <div className="ev-panel__head">
        <span className="ev-panel__title">Photographs</span>
        {/* No count on an empty album: the invitation below says it better, and a header
            reading "No photos yet" above an invitation is the empty state coming back in
            through the window. */}
        {photos.length > 0 ? (
          <span className="ev-photos__count">{photoCountLabel(photos.length)}</span>
        ) : null}
        <span className="ev-detail__bar-spacer" />
        {photos.length > 0 ? addButton : null}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="photo-input"
        onChange={event => void handleFiles(event.target.files)}
      />

      {problem ? (
        <MessageStrip design="Negative" onClose={() => setProblem(null)}>
          {problem}
        </MessageStrip>
      ) : null}
      {notice ? (
        <MessageStrip design="Positive" onClose={() => setNotice(null)}>
          {notice}
        </MessageStrip>
      ) : null}

      {photos.length === 0 ? (
        past ? (
          <div className="ev-invite" data-testid="photo-invitation">
            <span className="ev-invite__icon" aria-hidden="true">
              <Icon name="camera" />
            </span>
            <div className="ev-invite__body">
              <h3 className="ev-invite__title">{photoInvitation(event)}</h3>
              <p className="ev-invite__line">
                It finished on {formatDay(event.endsOn ?? event.startsOn)} and every receipt from it
                is filed. The pictures are the half worth keeping — put them here and they stay with
                the event, next to what it came to.
              </p>
              <div className="ev-invite__action">{addButton}</div>
            </div>
          </div>
        ) : (
          <div className="ev-photos__waiting" data-testid="photo-waiting">
            <Text>
              No photographs yet. They do not have to wait until it is over — anything taken on day
              one belongs here on day one.
            </Text>
            <div>{addButton}</div>
          </div>
        )
      ) : (
        <ul className="ev-photos" data-testid="photo-grid">
          {photos.map((photo, position) => (
            <li className="ev-photos__cell" key={photo.ID}>
              <button
                type="button"
                className="ev-photos__tile"
                data-testid="photo-thumb"
                data-photo-id={photo.ID}
                aria-label={`Open ${photoAlt(photo, position, photos.length, event.name)}`}
                onClick={() => setOpenId(photo.ID)}
              >
                <img
                  src={api.eventPhotoUrl(photo.ID)}
                  alt={photoAlt(photo, position, photos.length, event.name)}
                  loading="lazy"
                />
                {photo.caption ? <span className="ev-photos__caption">{photo.caption}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {busy ? (
        <span className="ev-photos__progress" aria-live="polite">
          Resizing and uploading {Math.min(progress.done + 1, progress.total)} of {progress.total} —
          each picture is shrunk on this device before it goes anywhere.
        </span>
      ) : null}

      {openIndex >= 0 ? (
        <PhotoLightbox
          photos={photos}
          index={openIndex}
          eventName={event.name}
          onMove={next => setOpenId(photos[next]?.ID ?? null)}
          onClose={() => setOpenId(null)}
          onSaveDetails={handleSaveDetails}
          onRequestDelete={photo => setPendingDelete(photo)}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this photograph?"
        destructive
        busy={deleting}
        confirmText="Delete photo"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void handleDelete()}
      >
        <Text>
          {pendingDelete?.caption
            ? `“${pendingDelete.caption}” goes for good. The event and everything posted to it stay exactly as they are.`
            : 'It goes for good. The event and everything posted to it stay exactly as they are.'}
        </Text>
      </ConfirmDialog>
    </section>
  )
}

export default PhotoGallery
