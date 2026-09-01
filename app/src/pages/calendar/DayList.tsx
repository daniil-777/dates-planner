/**
 * The month as a list.
 *
 * Seven columns on a 360 px phone give each day about 45 px, which is enough for a
 * number and two dots and not enough to read "Engadin Between the Years". So the same
 * month is also available as days in a column, with the actual names on them, and only
 * the days that carry something — a list of thirty rows, twenty-seven of them empty, is
 * a worse answer than a grid.
 */

import { Button } from '@ui5/webcomponents-react'
import { formatLongDate } from '../memories/dates'
import { EntryRow } from './EntryRow'
import type { DayBucket, DayEntry } from './entries'
import { WEEKDAY_NAMES, weekdayIndex } from './grid'

export interface DayListProps {
  buckets: readonly DayBucket[]
  /** `YYYY-MM-DD`, so today's card can be marked the way today's cell is. */
  today: string
  onOpenEvent: (eventId: string) => void
  onCompleteReminder: (id: string) => void
  onDeleteReminder: (item: DayEntry) => void
  onRemindAbout: (item: DayEntry) => void
  onAddReminder: (date: string) => void
  busyId: string | null
}

export function DayList({
  buckets,
  today,
  onOpenEvent,
  onCompleteReminder,
  onDeleteReminder,
  onRemindAbout,
  onAddReminder,
  busyId,
}: DayListProps) {
  return (
    <ul className="cal-list" data-testid="calendar-list">
      {buckets.map(bucket => {
        const weekday = WEEKDAY_NAMES[weekdayIndex(bucket.date)] ?? ''
        const classes = ['cal-list__day']
        if (bucket.date === today) classes.push('cal-list__day--today')

        return (
          <li className={classes.join(' ')} key={bucket.date} data-date={bucket.date}>
            <div className="cal-list__head">
              <span className="cal-list__date">{formatLongDate(bucket.date)}</span>
              <span className="cal-list__weekday">
                {bucket.date === today ? `${weekday} · today` : weekday}
              </span>
              <Button
                design="Transparent"
                icon="add"
                accessibleName={`Add a reminder on ${formatLongDate(bucket.date)}`}
                tooltip="Add a reminder"
                onClick={() => onAddReminder(bucket.date)}
              />
            </div>
            <ul className="cal-entries">
              {bucket.items.map(item => (
                <EntryRow
                  key={item.key}
                  item={item}
                  busyId={busyId}
                  onOpen={onOpenEvent}
                  onComplete={onCompleteReminder}
                  onDelete={onDeleteReminder}
                  onRemind={onRemindAbout}
                />
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}

export default DayList
