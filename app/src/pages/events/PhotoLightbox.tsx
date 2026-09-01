import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DatePicker, Icon, Input, MessageStrip } from '@ui5/webcomponents-react'
import { api } from '@/api/client'
import type { EventPhoto } from '@/api/types'
import './icons'
import { formatSwissDate, parseSwissDate } from './dates'
import { CAPTION_MAX, photoAlt, photoDateLabel, type PhotoDetails } from './photos'

export interface PhotoLightboxProps {
  /** The whole album, in display order — the lightbox walks it. */
  photos: readonly EventPhoto[]
  /** Which one is on screen. The parent owns it so the grid and the viewer stay in step. */
  index: number
  eventName: string
  onMove: (index: number) => void
  onClose: () => void
  /** Resolves when the caption is saved; rejects with something worth showing a human. */
  onSaveDetails: (photoId: string, details: PhotoDetails) => Promise<void>
  /** Asks the parent to confirm and delete — the dialog lives out there, above this. */
  onRequestDelete: (photo: EventPhoto) => void
}

/** Everything inside the overlay a Tab can land on, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"]), ' +
  'ui5-button:not([disabled]), ui5-input, ui5-date-picker'

/**
 * One photograph, filling the screen, with the rest of the album a key away.
 *
 * This is a hand-built overlay rather than a `Dialog`, for three reasons that all point the
 * same way. A picture wants the whole viewport and no chrome around it, which is the opposite
 * of what a Fiori dialog is shaped for. Arrow keys have to reach the viewer itself, not a
 * focused control inside it. And the controls sit on a dark scrim, where the light theme's
 * buttons would be invisible. What a dialog *does* give — a modal role, a focus trap, Escape,
 * and putting focus back where it came from — is implemented here instead, because those are
 * the parts a keyboard user actually needs.
 *
 * The caption form is inline rather than a second dialog on top of this one: a modal over a
 * modal is where focus management goes to die, and the caption belongs under the picture it
 * describes anyway.
 */
export function PhotoLightbox({
  photos,
  index,
  eventName,
  onMove,
  onClose,
  onSaveDetails,
  onRequestDelete,
}: PhotoLightboxProps) {
  const frame = useRef<HTMLDivElement | null>(null)
  const returnFocusTo = useRef<Element | null>(null)

  const [editing, setEditing] = useState(false)
  const [caption, setCaption] = useState('')
  const [takenOn, setTakenOn] = useState<string | null>(null)
  const [dateInvalid, setDateInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [broken, setBroken] = useState(false)

  const count = photos.length
  const photo = photos[index]
  const photoId = photo?.ID ?? ''

  const canGoBack = index > 0
  const canGoOn = index < count - 1

  // Moving to another picture abandons a half-typed caption rather than carrying it across —
  // silently pasting one photo's words onto the next would be worse than losing them.
  useEffect(() => {
    setEditing(false)
    setError(null)
    setBroken(false)
  }, [photoId])

  const startEditing = useCallback(() => {
    if (!photo) return
    setCaption(photo.caption ?? '')
    setTakenOn(photo.takenOn)
    setDateInvalid(false)
    setError(null)
    setEditing(true)
  }, [photo])

  const stopEditing = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const save = useCallback(async () => {
    if (!photo || dateInvalid) return
    setSaving(true)
    setError(null)
    try {
      await onSaveDetails(photo.ID, { caption, takenOn })
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The caption could not be saved.')
    } finally {
      setSaving(false)
    }
  }, [caption, dateInvalid, onSaveDetails, photo, takenOn])

  /* ---------------------------------------------------------------- *
   *  Keyboard: arrows move, Escape closes, Tab stays inside
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const container = frame.current
        if (!container) return
        const stops = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (stops.length === 0) return
        const first = stops[0]
        const last = stops[stops.length - 1]
        const active = document.activeElement
        if (event.shiftKey && (active === first || active === container)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }

      // While a caption is being typed the arrows belong to the text field, and Escape means
      // "stop editing" rather than "throw the viewer away".
      if (editing) {
        if (event.key === 'Escape') {
          event.preventDefault()
          stopEditing()
        }
        return
      }

      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onClose()
          break
        case 'ArrowLeft':
          if (canGoBack) {
            event.preventDefault()
            onMove(index - 1)
          }
          break
        case 'ArrowRight':
          if (canGoOn) {
            event.preventDefault()
            onMove(index + 1)
          }
          break
        case 'Home':
          if (count > 0) {
            event.preventDefault()
            onMove(0)
          }
          break
        case 'End':
          if (count > 0) {
            event.preventDefault()
            onMove(count - 1)
          }
          break
        default:
          break
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [canGoBack, canGoOn, count, editing, index, onClose, onMove, stopEditing])

  // Take focus on the way in and hand it back on the way out, so closing the viewer does not
  // dump a keyboard user at the top of the document.
  useEffect(() => {
    returnFocusTo.current = document.activeElement
    frame.current?.focus()
    return () => {
      const target = returnFocusTo.current
      if (target instanceof HTMLElement && document.contains(target)) target.focus()
    }
  }, [])

  if (!photo) return null

  const captionText = photo.caption?.trim() ?? ''

  return (
    <div
      className="ev-lightbox"
      data-testid="photo-lightbox"
      data-photo-id={photo.ID}
      role="dialog"
      aria-modal="true"
      aria-label={`${eventName} — photo ${index + 1} of ${count}`}
      tabIndex={-1}
      ref={frame}
      onClick={event => {
        // Only the scrim itself closes; a click that started on the picture or a control
        // bubbles up here too and must not be read as "dismiss".
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="ev-lightbox__bar">
        <span className="ev-lightbox__counter" data-testid="lightbox-counter">
          {index + 1} of {count}
        </span>
        <span className="ev-lightbox__bar-spacer" />
        <button
          type="button"
          className="ev-lightbox__action"
          data-testid="lightbox-caption"
          aria-label={captionText ? 'Edit this caption' : 'Add a caption'}
          onClick={startEditing}
        >
          <Icon name="write-new" aria-hidden="true" />
          <span>{captionText ? 'Edit caption' : 'Add caption'}</span>
        </button>
        <button
          type="button"
          className="ev-lightbox__action ev-lightbox__action--danger"
          data-testid="lightbox-delete"
          aria-label="Delete this photo"
          onClick={() => onRequestDelete(photo)}
        >
          <Icon name="delete" aria-hidden="true" />
          <span>Delete</span>
        </button>
        <button
          type="button"
          className="ev-lightbox__icon"
          data-testid="lightbox-close"
          aria-label="Close the photo viewer"
          onClick={onClose}
        >
          <Icon name="decline" aria-hidden="true" />
        </button>
      </div>

      <div className="ev-lightbox__stage">
        <button
          type="button"
          className="ev-lightbox__nav"
          data-testid="lightbox-previous"
          aria-label="Previous photo"
          disabled={!canGoBack}
          onClick={() => onMove(index - 1)}
        >
          <Icon name="navigation-left-arrow" aria-hidden="true" />
        </button>

        {broken ? (
          <p className="ev-lightbox__broken" data-testid="lightbox-broken">
            This picture could not be loaded. It is still on the event — try again in a moment.
          </p>
        ) : (
          <img
            className="ev-lightbox__image"
            data-testid="lightbox-image"
            src={api.eventPhotoUrl(photo.ID)}
            alt={photoAlt(photo, index, count, eventName)}
            onError={() => setBroken(true)}
          />
        )}

        <button
          type="button"
          className="ev-lightbox__nav"
          data-testid="lightbox-next"
          aria-label="Next photo"
          disabled={!canGoOn}
          onClick={() => onMove(index + 1)}
        >
          <Icon name="navigation-right-arrow" aria-hidden="true" />
        </button>
      </div>

      <div className="ev-lightbox__foot">
        {editing ? (
          <div className="ev-lightbox__form" data-testid="caption-form">
            {error ? <MessageStrip design="Negative">{error}</MessageStrip> : null}
            <Input
              value={caption}
              maxlength={CAPTION_MAX}
              placeholder="What is happening here?"
              accessibleName="Caption"
              data-testid="caption-input"
              onInput={event => setCaption(event.target.value ?? '')}
            />
            <div className="ev-lightbox__form-row">
              <DatePicker
                formatPattern="dd.MM.yyyy"
                value={formatSwissDate(takenOn)}
                accessibleName="Taken on"
                valueState={dateInvalid ? 'Negative' : 'None'}
                onChange={event => {
                  const raw = event.detail.value ?? ''
                  if (raw.trim() === '') {
                    setDateInvalid(false)
                    setTakenOn(null)
                    return
                  }
                  const iso = parseSwissDate(raw)
                  if (!iso) {
                    setDateInvalid(true)
                    return
                  }
                  setDateInvalid(false)
                  setTakenOn(iso)
                }}
              />
              <Button design="Transparent" disabled={saving} onClick={stopEditing}>
                Cancel
              </Button>
              <Button
                design="Emphasized"
                disabled={saving || dateInvalid}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <span className="ev-lightbox__hint">
              The date is yours to fill in: every picture's own timestamp is stripped out with the
              rest of its metadata before it is stored.
            </span>
          </div>
        ) : (
          <>
            <p className="ev-lightbox__caption" data-testid="lightbox-caption-text">
              {captionText || 'No caption yet.'}
            </p>
            <p className="ev-lightbox__date" data-testid="lightbox-date">
              {photoDateLabel(photo)}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default PhotoLightbox
