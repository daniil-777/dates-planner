/**
 * One day, opened.
 *
 * The sheet is mounted only while a day is chosen. A UI5 `Dialog` keeps its children in
 * the light DOM whether it is open or not, so a permanently mounted one leaves yesterday's
 * rows in the document for a screen reader — and for a test — to find.
 */

import { Bar, Button, Dialog, Text } from '@ui5/webcomponents-react'
import { formatLongDate } from '../memories/dates'
import { EntryRow } from './EntryRow'
import type { DayEntry } from './entries'
import { WEEKDAY_NAMES, weekdayIndex } from './grid'

export interface DaySheetProps {
  /** `YYYY-MM-DD` of the day being shown. */
  date: string
  items: readonly DayEntry[]
  onClose: () => void
  onOpenEvent: (eventId: string) => void
  onCompleteReminder: (id: string) => void
  onDeleteReminder: (item: DayEntry) => void
  onRemindAbout: (item: DayEntry) => void
  onAddReminder: (date: string) => void
  busyId: string | null
}

export function DaySheet({
  date,
  items,
  onClose,
  onOpenEvent,
  onCompleteReminder,
  onDeleteReminder,
  onRemindAbout,
  onAddReminder,
  busyId,
}: DaySheetProps) {
  const weekday = WEEKDAY_NAMES[weekdayIndex(date)] ?? ''

  return (
    <Dialog
      open
      headerText={formatLongDate(date)}
      onClose={onClose}
      className="cal-sheet"
      data-testid="day-sheet"
      footer={
        <Bar
          design="Footer"
          startContent={
            <Button design="Transparent" icon="add" onClick={() => onAddReminder(date)}>
              Add a reminder
            </Button>
          }
          endContent={
            <Button design="Emphasized" onClick={onClose}>
              Close
            </Button>
          }
        />
      }
    >
      <div className="cal-sheet__body">
        <Text className="cal-label">{weekday}</Text>
        {items.length === 0 ? (
          <Text>Nothing on this day. A reminder can still be pinned to it.</Text>
        ) : (
          <ul className="cal-entries">
            {items.map(item => (
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
        )}
      </div>
    </Dialog>
  )
}

export default DaySheet
