import { useEffect, useRef, useState } from 'react'
import {
  Bar,
  Button,
  DatePicker,
  Dialog,
  Input,
  Label,
  MessageStrip,
  Switch,
  TextArea,
} from '@ui5/webcomponents-react'
import type { Person } from '@/api/types'
import { PersonPicker } from '@/components/PersonPicker'
import { formatSwissDate, parseSwissDate, todayIso } from './dates'
import { surpriseLock } from './surprise'

/** What the dialog collects. `eventID` null means this is a new event. */
export interface EventFormValues {
  eventID: string | null
  name: string
  startsOn: string
  /** null for a single-day event — a dinner has no second date. */
  endsOn: string | null
  place: string
  note: string
  participantIds: string[]
  /**
   * CONTRACTS §11.3. While this holds and `revealedAt` is empty, the event is visible to
   * nobody but the person who created it — the money it costs still is, to everybody.
   */
  isSurprise: boolean
  /**
   * Read-only here; the dialog never writes it (that is `revealSurprise`'s job). It is
   * carried so the switch can say why it has stopped mattering.
   */
  revealedAt: string | null
}

export interface EventEditorProps {
  open: boolean
  /** Seed values; the dialog re-seeds whenever a different event is opened. */
  draft: EventFormValues | null
  /** Everybody on the roster, for the participant picker. */
  people: readonly Person[]
  saving: boolean
  error: string | null
  onCancel: () => void
  onSave: (values: EventFormValues) => void
}

export function blankEvent(): EventFormValues {
  return {
    eventID: null,
    name: '',
    startsOn: todayIso(),
    endsOn: null,
    place: '',
    note: '',
    participantIds: [],
    isSurprise: false,
    revealedAt: null,
  }
}

/**
 * Create or rename an event.
 *
 * The end date is genuinely optional and clearing it is a supported edit, so the field
 * distinguishes three states rather than two: empty (a one-day event), parseable (a range),
 * and typed-but-wrong (kept on screen with a message instead of silently discarded).
 */
export function EventEditor({
  open,
  draft,
  people,
  saving,
  error,
  onCancel,
  onSave,
}: EventEditorProps) {
  const [values, setValues] = useState<EventFormValues>(() => draft ?? blankEvent())
  const [startInvalid, setStartInvalid] = useState(false)
  const [endInvalid, setEndInvalid] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // Read the seed through a ref so re-seeding depends on *which* event is open, not on the
  // identity of the object the parent happened to rebuild this render.
  const draftRef = useRef<EventFormValues | null>(draft)
  draftRef.current = draft

  const seedKey = open ? (draft?.eventID ?? 'new') : 'closed'
  useEffect(() => {
    if (!open) return
    setValues(draftRef.current ?? blankEvent())
    setStartInvalid(false)
    setEndInvalid(false)
    setSubmitted(false)
  }, [open, seedKey])

  const lockedReason = surpriseLock({ revealedAt: values.revealedAt, startsOn: values.startsOn })
  const surpriseLocked = lockedReason !== null

  const nameMissing = values.name.trim().length === 0
  const endBeforeStart = values.endsOn !== null && values.endsOn < values.startsOn
  const canSave = !nameMissing && !startInvalid && !endInvalid && !endBeforeStart && !saving

  const handleStartChange = (raw: string) => {
    const iso = parseSwissDate(raw)
    if (!iso) {
      setStartInvalid(true)
      return
    }
    setStartInvalid(false)
    setValues(previous => ({ ...previous, startsOn: iso }))
  }

  const handleEndChange = (raw: string) => {
    if (raw.trim() === '') {
      setEndInvalid(false)
      setValues(previous => ({ ...previous, endsOn: null }))
      return
    }
    const iso = parseSwissDate(raw)
    if (!iso) {
      setEndInvalid(true)
      return
    }
    setEndInvalid(false)
    setValues(previous => ({ ...previous, endsOn: iso }))
  }

  const handleSubmit = () => {
    setSubmitted(true)
    if (!canSave) return
    onSave({
      ...values,
      name: values.name.trim(),
      place: values.place.trim(),
      note: values.note.trim(),
    })
  }

  return (
    <Dialog
      open={open}
      className="ev-editor"
      headerText={values.eventID ? 'Edit event' : 'New event'}
      onClose={() => onCancel()}
      data-testid="event-editor"
      footer={
        <Bar
          design="Footer"
          endContent={
            <>
              <Button design="Transparent" onClick={() => onCancel()}>
                Cancel
              </Button>
              <Button design="Emphasized" disabled={!canSave} onClick={handleSubmit}>
                {values.eventID ? 'Save' : 'Create event'}
              </Button>
            </>
          }
        />
      }
    >
      <div className="ev-editor__form">
        {error ? <MessageStrip design="Negative">{error}</MessageStrip> : null}

        <div className="ev-field">
          <Label required>Name</Label>
          <Input
            value={values.name}
            placeholder="Lisbon Weekend"
            valueState={submitted && nameMissing ? 'Negative' : 'None'}
            onInput={event => {
              const next = event.target.value ?? ''
              setValues(previous => ({ ...previous, name: next }))
            }}
          />
          {submitted && nameMissing ? (
            <span className="ev-editor__hint">An event needs a name to be found again.</span>
          ) : null}
        </div>

        <div className="ev-field__row">
          <div className="ev-field">
            <Label required>Starts on</Label>
            <DatePicker
              formatPattern="dd.MM.yyyy"
              value={formatSwissDate(values.startsOn)}
              valueState={startInvalid ? 'Negative' : 'None'}
              onChange={event => handleStartChange(event.detail.value ?? '')}
            />
          </div>

          <div className="ev-field">
            <Label>Ends on</Label>
            <DatePicker
              formatPattern="dd.MM.yyyy"
              value={formatSwissDate(values.endsOn)}
              valueState={endInvalid || endBeforeStart ? 'Negative' : 'None'}
              onChange={event => handleEndChange(event.detail.value ?? '')}
            />
            <span className="ev-editor__hint">
              {endBeforeStart
                ? 'The end is before the start.'
                : 'Leave empty for a single day, like a dinner.'}
            </span>
          </div>
        </div>

        <div className="ev-field">
          <Label>Place</Label>
          <Input
            value={values.place}
            placeholder="Lisboa"
            onInput={event => {
              const next = event.target.value ?? ''
              setValues(previous => ({ ...previous, place: next }))
            }}
          />
        </div>

        <div className="ev-field">
          <Label>Who was there</Label>
          <PersonPicker
            people={[...people]}
            selectedIds={values.participantIds}
            label="Participants"
            multiple
            onChange={ids => setValues(previous => ({ ...previous, participantIds: ids }))}
          />
          <span className="ev-editor__hint">
            Postings on this event count towards its total whoever paid for them.
          </span>
        </div>

        <div className="ev-field ev-field--switch">
          <div className="ev-field__switch-row">
            <Label for="ev-surprise">Keep it a surprise</Label>
            <Switch
              id="ev-surprise"
              checked={values.isSurprise}
              disabled={surpriseLocked}
              accessibleName="Keep this event a surprise"
              data-testid="surprise-switch"
              onChange={event => {
                const on = event.target.checked
                setValues(previous => ({ ...previous, isSurprise: on }))
              }}
            />
          </div>
          <span className="ev-editor__hint">
            {lockedReason ??
              'Nobody but you sees it until you reveal it, or until the day itself arrives. ' +
                'What it costs still shows up in the month as usual — a hole in the total would ' +
                'give it away faster than a name ever could.'}
          </span>
        </div>

        <div className="ev-field">
          <Label>Note</Label>
          <TextArea
            value={values.note}
            rows={4}
            growing
            growingMaxRows={10}
            placeholder="Anything worth remembering about it"
            onInput={event => {
              const next = event.target.value ?? ''
              setValues(previous => ({ ...previous, note: next }))
            }}
          />
        </div>
      </div>
    </Dialog>
  )
}

export default EventEditor
