/**
 * The memory editor.
 *
 * Two things are load-bearing here:
 *
 *  - **Saving never waits for geocoding.** The place is free text that stands
 *    on its own; coordinates are an optional garnish that makes the map view
 *    richer. If Nominatim is slow, rate-limited, blocked or simply wrong, the
 *    Save button does not care, and manual coordinates are always available.
 *  - **Photos are downscaled on the device** before they are ever queued for
 *    upload, so a 9 MB phone photo becomes a ~200 kB JPEG.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BusyIndicator,
  Button,
  DatePicker,
  Dialog,
  Icon,
  Input,
  Label,
  MessageStrip,
  Option,
  Select,
  Switch,
  Text,
  TextArea,
} from '@ui5/webcomponents-react'
import type { MemoryKind, Photo } from '@/api/types'
import { api } from '@/api/client'
import { formatSwissDate, parseSwissDate, todayIso } from './dates'
import { useGeocodeSuggestions, type GeocodeStatus } from './geocode'
import { MAX_PHOTOS_PER_MEMORY, formatBytes, preparePhoto, type PreparedPhoto } from './photos'
import { MEMORY_KINDS, kindIcon, kindLabel } from './timeline'

export interface MemoryFormValues {
  memoryID: string | null
  expenseID: string | null
  title: string
  note: string
  occurredOn: string
  kind: MemoryKind
  pinned: boolean
  place: string
  lat: number | null
  lon: number | null
  /** Existing photos the user chose to keep. Omitted ones are deleted. */
  keptPhotos: Photo[]
}

export interface MemoryEditorProps {
  open: boolean
  /** Seed values; `memoryID` null means this is a new memory. */
  draft: MemoryFormValues | null
  saving: boolean
  error: string | null
  onCancel: () => void
  onSave: (values: MemoryFormValues, addedPhotos: PreparedPhoto[]) => void
}

const GEOCODE_MESSAGES: Record<GeocodeStatus, string> = {
  idle: '',
  typing: 'Waiting for you to stop typing…',
  searching: 'Looking the place up on OpenStreetMap…',
  ready: 'Pick a match to pin this memory on the map.',
  empty: 'No match found. The place name is saved either way.',
  error: 'Place lookup is unavailable. Enter coordinates by hand, or just save.',
  unavailable: 'Place lookup is unavailable offline. The place name is saved either way.',
}

function emptyDraft(): MemoryFormValues {
  return {
    memoryID: null,
    expenseID: null,
    title: '',
    note: '',
    occurredOn: todayIso(),
    kind: 'date_night',
    pinned: false,
    place: '',
    lat: null,
    lon: null,
    keptPhotos: [],
  }
}

function parseCoordinate(value: string, limit: number): number | null {
  const trimmed = value.trim().replace(',', '.')
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return null
  return parsed
}

export function MemoryEditor({ open, draft, saving, error, onCancel, onSave }: MemoryEditorProps) {
  const [values, setValues] = useState<MemoryFormValues>(() => draft ?? emptyDraft())
  const [added, setAdded] = useState<PreparedPhoto[]>([])
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [placeTouched, setPlaceTouched] = useState(false)
  const [manualCoords, setManualCoords] = useState(false)
  const [latText, setLatText] = useState('')
  const [lonText, setLonText] = useState('')
  const [dateInvalid, setDateInvalid] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const addedRef = useRef<PreparedPhoto[]>([])
  addedRef.current = added
  // Read through a ref so re-seeding depends on *which* memory is open, not on
  // the identity of the object the parent happened to rebuild this render.
  const draftRef = useRef<MemoryFormValues | null>(draft)
  draftRef.current = draft

  // Re-seed whenever a different memory is opened. The identity of the draft
  // object is not stable, so key off the ids it carries.
  const seedKey = open ? `${draft?.memoryID ?? 'new'}:${draft?.expenseID ?? '-'}` : 'closed'
  useEffect(() => {
    if (!open) return
    const seed = draftRef.current ?? emptyDraft()
    setValues(seed)
    setAdded(previous => {
      previous.forEach(photo => URL.revokeObjectURL(photo.previewUrl))
      return []
    })
    setPhotoError(null)
    setPlaceTouched(false)
    setManualCoords(seed.lat !== null && seed.lon !== null && !seed.place)
    setLatText(seed.lat === null ? '' : String(seed.lat))
    setLonText(seed.lon === null ? '' : String(seed.lon))
    setDateInvalid(false)
    setSubmitted(false)
  }, [open, seedKey])

  // Object URLs are process-wide; drop them when the editor goes away.
  useEffect(
    () => () => {
      addedRef.current.forEach(photo => URL.revokeObjectURL(photo.previewUrl))
    },
    [],
  )

  const suggestions = useGeocodeSuggestions(values.place, open && placeTouched && !manualCoords)

  const photoCount = values.keptPhotos.length + added.length
  const titleMissing = values.title.trim().length === 0
  const canSave = !titleMissing && !dateInvalid && !saving

  const geocodeMessage = useMemo(() => GEOCODE_MESSAGES[suggestions.status], [suggestions.status])

  const pickFiles = () => fileInput.current?.click()

  const onFilesPicked = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setPhotoBusy(true)
    setPhotoError(null)
    const room = MAX_PHOTOS_PER_MEMORY - photoCount
    const files = Array.from(fileList).slice(0, Math.max(0, room))
    if (files.length < fileList.length) {
      setPhotoError(`A memory holds up to ${MAX_PHOTOS_PER_MEMORY} photos.`)
    }
    const prepared: PreparedPhoto[] = []
    for (const file of files) {
      try {
        prepared.push(await preparePhoto(file))
      } catch {
        setPhotoError(`“${file.name}” could not be read as an image.`)
      }
    }
    setAdded(previous => [...previous, ...prepared])
    setPhotoBusy(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  const removeAdded = (id: string) => {
    setAdded(previous => {
      const target = previous.find(photo => photo.ID === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return previous.filter(photo => photo.ID !== id)
    })
  }

  const removeKept = (id: string) => {
    setValues(previous => ({
      ...previous,
      keptPhotos: previous.keptPhotos.filter(photo => photo.ID !== id),
    }))
  }

  const submit = () => {
    setSubmitted(true)
    if (titleMissing || dateInvalid) return
    const lat = manualCoords ? parseCoordinate(latText, 90) : values.lat
    const lon = manualCoords ? parseCoordinate(lonText, 180) : values.lon
    onSave(
      {
        ...values,
        title: values.title.trim().slice(0, 200),
        place: values.place.trim().slice(0, 200),
        note: values.note,
        lat: lat === null || lon === null ? null : lat,
        lon: lat === null || lon === null ? null : lon,
      },
      added,
    )
  }

  return (
    <Dialog
      open={open}
      headerText={values.memoryID ? 'Edit memory' : 'New memory'}
      onClose={onCancel}
      footer={
        <Bar
          design="Footer"
          endContent={
            <>
              <Button design="Transparent" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button design="Emphasized" onClick={submit} disabled={!canSave}>
                {saving ? 'Posting…' : 'Post memory'}
              </Button>
            </>
          }
        />
      }
    >
      <div className="tw-editor">
        {error ? <MessageStrip design="Negative">{error}</MessageStrip> : null}

        <div className="tw-field">
          <Label required>Title</Label>
          <Input
            value={values.title}
            placeholder="What happened"
            maxlength={200}
            valueState={submitted && titleMissing ? 'Negative' : 'None'}
            onInput={event => {
              const next = event.target.value ?? ''
              setValues(previous => ({ ...previous, title: next }))
            }}
          />
          {submitted && titleMissing ? (
            <Text className="tw-label">A memory needs a title.</Text>
          ) : null}
        </div>

        <div className="tw-field__row">
          <div className="tw-field">
            <Label>Kind</Label>
            <Select
              onChange={event => {
                const next = event.detail.selectedOption.value
                if (next) setValues(previous => ({ ...previous, kind: next as MemoryKind }))
              }}
            >
              {MEMORY_KINDS.map(kind => (
                <Option
                  key={kind}
                  value={kind}
                  icon={kindIcon(kind)}
                  selected={values.kind === kind}
                >
                  {kindLabel(kind)}
                </Option>
              ))}
            </Select>
          </div>

          <div className="tw-field">
            <Label required>Occurred on</Label>
            <DatePicker
              formatPattern="dd.MM.yyyy"
              value={formatSwissDate(values.occurredOn)}
              valueState={dateInvalid ? 'Negative' : 'None'}
              onChange={event => {
                const iso = parseSwissDate(event.detail.value ?? '')
                if (iso) {
                  setDateInvalid(false)
                  setValues(previous => ({ ...previous, occurredOn: iso }))
                } else {
                  setDateInvalid(true)
                }
              }}
            />
          </div>
        </div>

        <div className="tw-field">
          <Label>Note</Label>
          <TextArea
            value={values.note}
            rows={5}
            growing
            growingMaxRows={12}
            placeholder="The bit worth keeping"
            onInput={event => {
              const next = event.target.value ?? ''
              setValues(previous => ({ ...previous, note: next }))
            }}
          />
        </div>

        <div className="tw-field">
          <Label>Place</Label>
          <Input
            value={values.place}
            placeholder="Where it happened"
            maxlength={200}
            onInput={event => {
              const next = event.target.value ?? ''
              // Retyping the place invalidates the pin that belonged to the old
              // one — a memory on the wrong side of the lake is worse than a
              // memory with no pin at all.
              setPlaceTouched(true)
              setValues(previous => ({ ...previous, place: next, lat: null, lon: null }))
            }}
          />

          {!manualCoords && geocodeMessage ? (
            <Text className="tw-label">
              {suggestions.status === 'searching' ? (
                <BusyIndicator active size="S" delay={0} />
              ) : null}
              {geocodeMessage}
            </Text>
          ) : null}

          {!manualCoords && suggestions.status === 'ready' ? (
            <div className="tw-suggestions">
              {suggestions.results.map(result => (
                <button
                  type="button"
                  key={`${result.lat},${result.lon}`}
                  className="tw-suggestions__item"
                  onClick={() => {
                    // Stop looking things up until the user types again:
                    // otherwise accepting a match immediately queues a second
                    // request for the label we were just given.
                    setPlaceTouched(false)
                    setValues(previous => ({
                      ...previous,
                      place: result.label.slice(0, 200),
                      lat: result.lat,
                      lon: result.lon,
                    }))
                  }}
                >
                  {result.label}
                </button>
              ))}
            </div>
          ) : null}

          {!manualCoords && values.lat !== null && values.lon !== null ? (
            <Text className="tw-label">
              <Icon name="locate-me" aria-hidden="true" /> Pinned at {values.lat.toFixed(5)},{' '}
              {values.lon.toFixed(5)}
            </Text>
          ) : null}
        </div>

        <div className="tw-editor__toggle">
          <Label>Enter coordinates by hand</Label>
          <Switch
            checked={manualCoords}
            accessibleName="Enter coordinates by hand"
            onChange={event => {
              const on = event.target.checked
              setManualCoords(on)
              if (on) {
                setLatText(values.lat === null ? '' : String(values.lat))
                setLonText(values.lon === null ? '' : String(values.lon))
              }
            }}
          />
        </div>

        {manualCoords ? (
          <div className="tw-field__row">
            <div className="tw-field">
              <Label>Latitude</Label>
              <Input
                value={latText}
                placeholder="47.36667"
                valueState={
                  latText.trim() !== '' && parseCoordinate(latText, 90) === null
                    ? 'Negative'
                    : 'None'
                }
                onInput={event => setLatText(event.target.value ?? '')}
              />
            </div>
            <div className="tw-field">
              <Label>Longitude</Label>
              <Input
                value={lonText}
                placeholder="8.55"
                valueState={
                  lonText.trim() !== '' && parseCoordinate(lonText, 180) === null
                    ? 'Negative'
                    : 'None'
                }
                onInput={event => setLonText(event.target.value ?? '')}
              />
            </div>
          </div>
        ) : null}

        <div className="tw-field">
          <Label>Photos</Label>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={event => void onFilesPicked(event.target.files)}
          />
          <div className="tw-field__row">
            <Button
              icon="add-photo"
              design="Transparent"
              disabled={photoBusy || photoCount >= MAX_PHOTOS_PER_MEMORY}
              onClick={pickFiles}
            >
              {photoBusy ? 'Preparing…' : 'Add photos'}
            </Button>
            <Text className="tw-label">
              {photoCount} of {MAX_PHOTOS_PER_MEMORY}
            </Text>
          </div>
          {photoError ? <MessageStrip design="Critical">{photoError}</MessageStrip> : null}

          {photoCount > 0 ? (
            <div className="tw-editor__photos">
              {values.keptPhotos.map(photo => (
                <div className="tw-editor__photo" key={photo.ID}>
                  <img
                    src={api.photoImageUrl(photo.ID)}
                    alt={photo.caption ?? 'Memory photo'}
                    loading="lazy"
                  />
                  <Button
                    icon="decline"
                    design="Transparent"
                    accessibleName="Remove photo"
                    onClick={() => removeKept(photo.ID)}
                  />
                </div>
              ))}
              {added.map(photo => (
                <div className="tw-editor__photo" key={photo.ID}>
                  <img
                    src={photo.previewUrl}
                    alt={photo.caption ?? 'New photo'}
                    title={formatBytes(photo.bytes)}
                  />
                  <Button
                    icon="decline"
                    design="Transparent"
                    accessibleName="Remove photo"
                    onClick={() => removeAdded(photo.ID)}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="tw-editor__toggle">
          <Label>Pin to the top of the timeline</Label>
          <Switch
            checked={values.pinned}
            accessibleName="Pin this memory"
            onChange={event => {
              const on = event.target.checked
              setValues(previous => ({ ...previous, pinned: on }))
            }}
          />
        </div>
      </div>
    </Dialog>
  )
}
