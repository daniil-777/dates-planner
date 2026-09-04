/**
 * The chosen day, under the grid.
 *
 * ## Why this is not a dialog any more
 *
 * It used to be one. Tapping a day opened a modal over the month, which is the pattern a
 * form uses — and a day is not a form. It is the thing the grid exists to show you, and the
 * grid had six hundred pixels of empty space under it while a sheet covered the grid to say
 * what was in the day you had just tapped.
 *
 * Every calendar people actually use puts the day's list directly beneath the month, and the
 * reason is not fashion: the month is context for the day. Being able to see "the 12th has
 * two things, and the 13th is free" while reading the 12th is the whole point of having a
 * month on screen at all, and a modal is precisely the thing that takes it away.
 *
 * ## There is always a day
 *
 * The panel never shows nothing. A month opens on today when today is in it and on the first
 * otherwise, so the space under the grid is always doing work. An empty day says it is empty
 * and offers the one thing you would want to do about that.
 */

import { Button } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/add.js'

import { formatLongDate } from '../memories/dates'
import { EntryRow } from './EntryRow'
import type { DayEntry } from './entries'
import { WEEKDAY_NAMES, weekdayIndex } from './grid'

export interface DayPanelProps {
  /** `YYYY-MM-DD`. */
  date: string
  items: readonly DayEntry[]
  onOpenEvent: (eventId: string) => void
  onCompleteReminder: (id: string) => void
  onDeleteReminder: (item: DayEntry) => void
  onRemindAbout: (item: DayEntry) => void
  onAddReminder: (date: string) => void
  busyId: string | null
}

export function DayPanel({
  date,
  items,
  onOpenEvent,
  onCompleteReminder,
  onDeleteReminder,
  onRemindAbout,
  onAddReminder,
  busyId,
}: DayPanelProps) {
  const weekday = WEEKDAY_NAMES[weekdayIndex(date)] ?? ''

  return (
    <section className="cal-day-panel" data-testid="day-panel" aria-label={formatLongDate(date)}>
      <header className="cal-day-panel__head">
        <h3 className="cal-day-panel__date">
          {/* The weekday leads, because the number is already on the grid above and the
              question the heading answers is "which day am I looking at". */}
          <span className="cal-day-panel__weekday">{weekday}</span>
          <span className="cal-day-panel__long">{formatLongDate(date)}</span>
        </h3>
      </header>

      {items.length === 0 ? (
        <p className="cal-day-panel__empty">Nothing on this day.</p>
      ) : (
        <ul className="cal-day-panel__list">
          {items.map(item => (
            <li key={item.key}>
              <EntryRow
                item={item}
                busyId={busyId}
                onOpen={onOpenEvent}
                onComplete={onCompleteReminder}
                onDelete={onDeleteReminder}
                onRemind={onRemindAbout}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Named rather than a bare `+` beside the date. On an empty day this is the only thing
          on screen, and "Add a reminder" is an offer where a plus sign is a puzzle. */}
      <Button
        className="cal-day-panel__add"
        design="Transparent"
        icon="add"
        onClick={() => onAddReminder(date)}
      >
        Add a reminder
      </Button>
    </section>
  )
}

export default DayPanel
