/**
 * Making a reminder: which event, how many days before it, and what to say.
 *
 * The due date is shown while it is being typed, because `leadDays` on its own is not a
 * date and "14" means nothing until it reads "due 13 December". Nothing here stores that
 * date: `dueOn` is `startsOn - leadDays` every time it is needed (CONTRACTS §11.2), so a
 * trip that moves takes its reminders with it.
 *
 * The limits — a whole number of days from 0 to 365, a note of at most 200 characters —
 * are the service's own, checked here so a mistake is a red field rather than a round trip.
 */

import { useState } from 'react'
import {
  Bar,
  Button,
  Dialog,
  Input,
  Label,
  MessageStrip,
  Option,
  Select,
  Text,
  TextArea,
} from '@ui5/webcomponents-react'
import type { Event } from '@/api/types'
import { formatDate } from '@/theme'
import { formatLongDate, todayIso } from '../memories/dates'
import { addDays } from './grid'

/** The service's own bounds — `createReminder` rejects anything outside them. */
export const MAX_LEAD_DAYS = 365
export const MAX_NOTE_LENGTH = 200

export interface ReminderDraft {
  eventId: string
  leadDays: number
  note: string
}

export interface ReminderDialogProps {
  /** Every event the viewer can see; surprises of theirs included. */
  events: readonly Event[]
  initial: ReminderDraft
  saving: boolean
  /** A message from the service, when the save came back rejected. */
  error: string | null
  onCancel: () => void
  onSave: (draft: ReminderDraft) => void
}

/** Soonest first among what is still ahead, then the past, most recent first. */
function pickOrder(events: readonly Event[], today: string): Event[] {
  const ahead = events.filter(event => (event.endsOn ?? event.startsOn) >= today)
  const behind = events.filter(event => (event.endsOn ?? event.startsOn) < today)
  ahead.sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name))
  behind.sort((a, b) => b.startsOn.localeCompare(a.startsOn) || a.name.localeCompare(b.name))
  return [...ahead, ...behind]
}

function optionLabel(event: Event): string {
  const secret = event.isSurprise === true && !event.revealedAt ? ' · only you' : ''
  return `${event.name} · ${formatDate(event.startsOn)}${secret}`
}

export function ReminderDialog({
  events,
  initial,
  saving,
  error,
  onCancel,
  onSave,
}: ReminderDialogProps) {
  const [draft, setDraft] = useState<ReminderDraft>(initial)

  const ordered = pickOrder(events, todayIso())
  const chosen = ordered.find(event => event.ID === draft.eventId) ?? null

  const leadValid =
    Number.isInteger(draft.leadDays) && draft.leadDays >= 0 && draft.leadDays <= MAX_LEAD_DAYS
  const noteValid = draft.note.length <= MAX_NOTE_LENGTH
  const valid = chosen !== null && leadValid && noteValid

  const dueOn = chosen ? addDays(chosen.startsOn, -draft.leadDays) : null

  return (
    <Dialog
      open
      headerText="New reminder"
      onClose={onCancel}
      className="cal-reminder"
      data-testid="reminder-dialog"
      footer={
        <Bar
          design="Footer"
          endContent={
            <>
              <Button design="Transparent" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                design="Emphasized"
                disabled={saving || !valid}
                onClick={() => onSave({ ...draft, note: draft.note.trim() })}
              >
                {saving ? 'Saving…' : 'Add reminder'}
              </Button>
            </>
          }
        />
      }
    >
      <div className="cal-form">
        {error ? <MessageStrip design="Negative">{error}</MessageStrip> : null}

        {ordered.length === 0 ? (
          <Text>
            A reminder hangs off an event, and there are no events yet. Create one first and the
            nudge can point at it.
          </Text>
        ) : (
          <>
            <div className="cal-field">
              <Label for="reminder-event">Event</Label>
              <Select
                id="reminder-event"
                value={draft.eventId}
                accessibleName="Event"
                onChange={event => {
                  const next = event.detail.selectedOption.value ?? ''
                  setDraft(previous => ({ ...previous, eventId: next }))
                }}
              >
                {ordered.map(candidate => (
                  <Option
                    key={candidate.ID}
                    value={candidate.ID}
                    selected={candidate.ID === draft.eventId}
                  >
                    {optionLabel(candidate)}
                  </Option>
                ))}
              </Select>
            </div>

            <div className="cal-field">
              <Label for="reminder-lead">Days before it starts</Label>
              <Input
                id="reminder-lead"
                type="Number"
                value={String(draft.leadDays)}
                accessibleName="Days before it starts"
                valueState={leadValid ? 'None' : 'Negative'}
                onInput={event => {
                  const parsed = Number.parseInt(event.target.value ?? '', 10)
                  setDraft(previous => ({
                    ...previous,
                    leadDays: Number.isNaN(parsed) ? 0 : parsed,
                  }))
                }}
              />
              <span className="cal-field__hint">
                {chosen === null
                  ? 'Pick an event first.'
                  : dueOn
                    ? `Fires on ${formatLongDate(dueOn)} — ${
                        draft.leadDays === 0
                          ? 'the day it starts'
                          : `${draft.leadDays} ${draft.leadDays === 1 ? 'day' : 'days'} before ${formatLongDate(chosen.startsOn)}`
                      }.`
                    : ''}
              </span>
            </div>

            <div className="cal-field">
              <Label for="reminder-note">Note</Label>
              <TextArea
                id="reminder-note"
                value={draft.note}
                rows={3}
                maxlength={MAX_NOTE_LENGTH}
                placeholder="Book the sleeper"
                accessibleName="Note"
                valueState={noteValid ? 'None' : 'Negative'}
                onInput={event => {
                  const next = event.target.value ?? ''
                  setDraft(previous => ({ ...previous, note: next }))
                }}
              />
              <span className="cal-field__hint">
                {`Optional. ${draft.note.length}/${MAX_NOTE_LENGTH} — without one the reminder is named after its event.`}
              </span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}

export default ReminderDialog
