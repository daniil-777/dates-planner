/**
 * One line of the calendar: an event, or a reminder pointing at one.
 *
 * The same row is used by the list view and by the day sheet, so that tapping the 14th
 * and scrolling to the 14th put the same thing in front of you. Everything that can be
 * done to a reminder is done from here — ticking it off and deleting it — because a
 * reminder has no page of its own; the event behind it does, and that is where the
 * title tap goes.
 */

import { Button, Icon } from '@ui5/webcomponents-react'
import { diffInDays } from '../memories/dates'
import type { DayEntry } from './entries'
import { leadLabel } from './entries'

export interface EntryRowProps {
  item: DayEntry
  /** Opens `/events/:id`. */
  onOpen: (eventId: string) => void
  onComplete: (reminderId: string) => void
  onDelete: (item: DayEntry) => void
  /** Offered on an event row: pin a nudge to this event without leaving the calendar. */
  onRemind: (item: DayEntry) => void
  /** The id of the reminder whose write is in flight, if any. */
  busyId?: string | null
}

/** `Day 2 of 4` for the middle of a trip; nothing for a one-day event. */
function dayOfSpan(item: DayEntry): string | null {
  if (item.entry.kind !== 'event' || item.span <= 1) return null
  const index = diffInDays(item.entry.date, item.date) + 1
  return `Day ${index} of ${item.span}`
}

/**
 * The grey line under the title.
 *
 * A reminder row says when it fires relative to its event and where that event is; it
 * cannot say *which* event by name, because `upcoming` gives a reminder the note as its
 * title and keeps only the event's place beside it. Tapping the row is what answers that,
 * and it answers it properly.
 */
function metaOf(item: DayEntry): string {
  const parts: string[] = []
  if (item.entry.kind === 'reminder') {
    parts.push(leadLabel(item.entry.leadDays))
    if (item.entry.done === true) parts.push('done')
  } else {
    const span = dayOfSpan(item)
    if (span) parts.push(span)
  }
  if (item.entry.place) parts.push(item.entry.place)
  return parts.filter(part => part.length > 0).join(' · ')
}

export function EntryRow({
  item,
  onOpen,
  onComplete,
  onDelete,
  onRemind,
  busyId = null,
}: EntryRowProps) {
  const { entry } = item
  const isReminder = entry.kind === 'reminder'
  const done = entry.done === true
  const busy = busyId === entry.ID
  const meta = metaOf(item)

  const classes = ['cal-entry', isReminder ? 'cal-entry--reminder' : 'cal-entry--event']
  if (done) classes.push('cal-entry--done')

  return (
    <li className={classes.join(' ')} data-testid="calendar-entry" data-kind={entry.kind}>
      <button
        type="button"
        className="cal-entry__open"
        disabled={!entry.eventId}
        onClick={() => {
          if (entry.eventId) onOpen(entry.eventId)
        }}
      >
        <Icon className="cal-entry__icon" name={isReminder ? 'bell' : 'calendar'} />
        <span className="cal-entry__text">
          <span className="cal-entry__title">
            {entry.title}
            {entry.onlyYou ? (
              <span className="cal-badge" data-testid="only-you">
                <Icon name="locked" />
                Only you
              </span>
            ) : null}
          </span>
          {meta ? <span className="cal-entry__meta">{meta}</span> : null}
        </span>
      </button>

      <span className="cal-entry__actions">
        {isReminder ? (
          <>
            {done ? null : (
              <Button
                design="Transparent"
                icon="accept"
                disabled={busy}
                accessibleName={`Mark “${entry.title}” done`}
                tooltip="Done"
                onClick={() => onComplete(entry.ID)}
              />
            )}
            <Button
              design="Transparent"
              icon="delete"
              disabled={busy}
              accessibleName={`Delete reminder “${entry.title}”`}
              tooltip="Delete"
              onClick={() => onDelete(item)}
            />
          </>
        ) : (
          <Button
            design="Transparent"
            icon="bell"
            disabled={!entry.eventId}
            accessibleName={`Remind me about ${entry.title}`}
            tooltip="Remind me"
            onClick={() => onRemind(item)}
          />
        )}
      </span>
    </li>
  )
}

export default EntryRow
