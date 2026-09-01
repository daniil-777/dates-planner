/**
 * Event photographs — the client half of CONTRACTS.md §11.1.
 *
 * There is exactly one image pipeline in this app and this file does not add a second. A
 * picked file goes through `pages/scan/imageProcessing.ts` — the same canvas re-encode the
 * receipt scanner uses, 2000 px long edge at JPEG q85 — and then through
 * `api.addEventPhoto`, which hands it to `srv/lib/images.ts` on the server for the
 * authoritative pass: EXIF stripped, auto-rotated, capped, re-encoded. The client-side
 * downscale is a courtesy to the network, not a security measure; the strip that matters
 * happens on the server, where it cannot be skipped by a different client.
 *
 * That ordering is why the upload never sends a capture date. A phone JPEG carries the
 * second it was taken, the camera's serial number and, very often, the exact coordinates of
 * somebody's home — and all of it is stripped before storage, deliberately. So `takenOn` is
 * only ever what a person typed, and the lightbox says so rather than inventing one.
 */

import { api } from '@/api/client'
import type { Event, EventPhoto } from '@/api/types'
import { MAX_UPLOAD_BYTES } from '../scan/constants'
import { formatBytes, isImageFile, prepareImage } from '../scan/imageProcessing'
import { formatDay, lastDayOf, todayIso } from './dates'

export { formatBytes, isImageFile }

/** `EventPhotos.caption` is `String(200)` in `db/schema.cds`; refuse to send more. */
export const CAPTION_MAX = 200

/**
 * How many files one tap of "Add photos" will take. Uploads run one at a time, so a picked
 * folder of four hundred holiday pictures would otherwise be a very long, very silent wait.
 */
export const MAX_PHOTOS_PER_UPLOAD = 24

/** One picked file, downscaled and ready for `api.addEventPhoto`. */
export interface PreparedEventPhoto {
  blob: Blob
  fileName: string
  /** What is actually going over the wire, after the resize — worth reporting back. */
  bytes: number
}

/**
 * Downscales one picked file on the device.
 *
 * A file the browser cannot decode is not an error here — `prepareImage` hands back the
 * original and the server normalises it — but a file that is *still* over the action's
 * ceiling after all that is refused now, with its size in the message, rather than after a
 * ten-megabyte round trip that ends in a 400.
 */
export async function prepareEventPhoto(file: File): Promise<PreparedEventPhoto> {
  const prepared = await prepareImage(file)
  if (prepared.blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `“${file.name || 'that picture'}” is ${formatBytes(prepared.blob.size)} even after ` +
        `resizing, and the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
    )
  }
  return { blob: prepared.blob, fileName: prepared.fileName, bytes: prepared.blob.size }
}

/**
 * Has the event finished? CONTRACTS §11.1: an event is past when `endsOn ?? startsOn` is
 * before today — so a trip is still "now" on its last evening, which is exactly when the
 * good photographs get taken.
 */
export function isPastEvent(
  event: Pick<Event, 'startsOn' | 'endsOn'>,
  today: string = todayIso(),
): boolean {
  return lastDayOf(event.startsOn, event.endsOn) < today
}

/**
 * The warm prompt a finished event with no pictures gets instead of an empty state.
 *
 * It names the place, because that is the word the photographs are filed under in a person's
 * head — "the Lisbon ones", not "the ones from event e-1". Falling back to the event's own
 * name keeps a nameless dinner from reading as "Add the photos from undefined".
 */
export function photoInvitation(event: Pick<Event, 'name' | 'place'>): string {
  const where = event.place?.trim() || event.name.trim()
  return where ? `Add the photos from ${where}` : 'Add the photos'
}

/**
 * Oldest first, so scrolling the grid walks forwards through the trip.
 *
 * Pictures with no date sit at the back rather than at the front: an undated photo is one
 * nobody has got round to yet, and putting it before day one would reorder the story around
 * the least-known thing in it. The `ID` tie-break keeps the order stable across refetches.
 */
export function sortPhotos(photos: readonly EventPhoto[]): EventPhoto[] {
  return [...photos].sort((a, b) => {
    if (a.takenOn && b.takenOn)
      return a.takenOn.localeCompare(b.takenOn) || a.ID.localeCompare(b.ID)
    if (a.takenOn) return -1
    if (b.takenOn) return 1
    return a.ID.localeCompare(b.ID)
  })
}

/** `'12 Apr 2026'`, or a plain admission that nobody wrote one down. */
export function photoDateLabel(photo: Pick<EventPhoto, 'takenOn'>): string {
  return formatDay(photo.takenOn) || 'No date recorded'
}

/**
 * What a screen reader should hear for a thumbnail.
 *
 * A caption is the best answer; without one, "Photo 3 of 11 from Lisbon Weekend" at least
 * says where in the set this is, which a bare "Event photo" eleven times over does not.
 */
export function photoAlt(
  photo: EventPhoto,
  index: number,
  count: number,
  eventName: string,
): string {
  const caption = photo.caption?.trim()
  if (caption) return caption
  return `Photo ${index + 1} of ${count} from ${eventName}`
}

/** `'3 photos'`, `'1 photo'`, `'No photos yet'`. */
export function photoCountLabel(count: number): string {
  if (count <= 0) return 'No photos yet'
  return `${count} ${count === 1 ? 'photo' : 'photos'}`
}

/* ------------------------------------------------------------------ *
 *  Writing back the two things a person types
 * ------------------------------------------------------------------ */

/** What the caption form can change. Both fields are always sent, so clearing one works. */
export interface PhotoDetails {
  caption: string | null
  /** 'YYYY-MM-DD', or null for "nobody wrote one down". */
  takenOn: string | null
}

/**
 * The row behind a photo, derived from the media-stream URL the API client hands out.
 *
 * `api.eventPhotoUrl` is the one place that knows the service's base path and how an OData
 * key is quoted; dropping the `/image` segment off it borrows both rather than rebuilding a
 * URL here that would drift the day the service moves.
 */
function photoRowUrl(photoId: string): string {
  return api.eventPhotoUrl(photoId).replace(/\/image$/, '')
}

/** CAP's error envelope, or the raw body when whatever answered was not CAP. */
async function refusalMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const envelope = (parsed as { error?: { message?: unknown } }).error
      if (envelope && typeof envelope.message === 'string' && envelope.message) {
        return envelope.message
      }
    }
  } catch {
    // Not JSON — a proxy in front of the app, most likely. Fall through.
  }
  return `${response.status} ${response.statusText}`.trim() || 'The caption could not be saved.'
}

/**
 * Saves a caption and a date onto an existing photograph.
 *
 * This is a PATCH on the row rather than an action, because it is the one write to
 * `EventPhotos` the server allows directly: `guardRawPhotoWrite` refuses every CREATE and
 * every payload carrying `image`, and deliberately lets a caption through — editing the words
 * under a picture is not a write of image bytes, and routing it through `addEventPhoto` would
 * mean re-uploading the photograph to rename it.
 *
 * There is no `api.updateEventPhoto` to call: `app/src/api/client.ts` belongs to another
 * agent and this page may not edit it. The URL still comes from the client (see
 * {@link photoRowUrl}) so only the verb and the body live here.
 */
export async function savePhotoDetails(photoId: string, details: PhotoDetails): Promise<void> {
  const caption = details.caption?.trim().slice(0, CAPTION_MAX) ?? ''
  const response = await fetch(photoRowUrl(photoId), {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ caption: caption === '' ? null : caption, takenOn: details.takenOn }),
  })
  if (!response.ok) throw new Error(await refusalMessage(response))
}
