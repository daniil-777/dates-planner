/**
 * The month grid.
 *
 * Keyboard behaviour follows the WAI-ARIA grid pattern, which is what a date picker is:
 * one roving tab stop, arrows to move a day at a time and a week at a time, Home and End
 * for the ends of the week, Page Up and Page Down for the month. Enter and Space open the
 * focused day — and they do it for free, because every cell is a real `<button>` rather
 * than a div with a click handler.
 *
 * Focus is only moved programmatically after a key press. Focusing on mount would steal
 * the caret from whatever the person was actually doing, and focusing whenever the month
 * changes would yank it away from the "next month" button they just clicked.
 */

import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { formatLongDate } from '../memories/dates'
import { formatPeriod, shiftPeriod } from '@/theme'
import type { DayCell } from './grid'
import { WEEKDAY_LABELS, addDays, sameDayInPeriod, weekdayIndex, weeksOf } from './grid'
import type { DayEntry } from './entries'
import { countsOf } from './entries'

export interface MonthGridProps {
  /** `YYYY-MM`. */
  period: string
  cells: readonly DayCell[]
  byDay: ReadonlyMap<string, DayEntry[]>
  /** The day holding the grid's single tab stop. */
  focusedDate: string
  /** The day whose sheet is open, if any. */
  selectedDate: string | null
  onFocusDate: (date: string) => void
  onOpenDate: (date: string) => void
}

/** At most three dots and two marks: past that the count is the information. */
const MAX_DOTS = 3
const MAX_MARKS = 2

/** What a screen reader hears instead of the dots. */
function summaryOf(events: number, reminders: number): string {
  const parts: string[] = []
  if (events > 0) parts.push(`${events} ${events === 1 ? 'event' : 'events'}`)
  if (reminders > 0) parts.push(`${reminders} ${reminders === 1 ? 'reminder' : 'reminders'}`)
  return parts.length > 0 ? parts.join(', ') : 'nothing scheduled'
}

export function MonthGrid({
  period,
  cells,
  byDay,
  focusedDate,
  selectedDate,
  onFocusDate,
  onOpenDate,
}: MonthGridProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const moveFocus = useRef(false)

  useEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    buttons.current.get(focusedDate)?.focus()
  }, [focusedDate, cells])

  const step = (date: string): void => {
    moveFocus.current = true
    onFocusDate(date)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = focusedDate
    switch (event.key) {
      case 'ArrowLeft':
        step(addDays(current, -1))
        break
      case 'ArrowRight':
        step(addDays(current, 1))
        break
      case 'ArrowUp':
        step(addDays(current, -7))
        break
      case 'ArrowDown':
        step(addDays(current, 7))
        break
      case 'Home':
        step(addDays(current, -weekdayIndex(current)))
        break
      case 'End':
        step(addDays(current, 6 - weekdayIndex(current)))
        break
      case 'PageUp':
        step(sameDayInPeriod(shiftPeriod(period, -1), current))
        break
      case 'PageDown':
        step(sameDayInPeriod(shiftPeriod(period, 1), current))
        break
      default:
        return
    }
    // Only reached when a key above matched: the arrows must not also scroll the page.
    event.preventDefault()
  }

  return (
    <div
      className="cal-grid"
      role="grid"
      aria-label={`${formatPeriod(period)}, month view`}
      data-testid="calendar-grid"
      onKeyDown={handleKeyDown}
    >
      <div className="cal-grid__row cal-grid__head" role="row">
        {WEEKDAY_LABELS.map(label => (
          <div className="cal-grid__weekday" role="columnheader" key={label}>
            {label}
          </div>
        ))}
      </div>

      {weeksOf(cells).map(week => (
        <div className="cal-grid__row" role="row" key={week[0].date}>
          {week.map(cell => {
            const items = byDay.get(cell.date)
            const counts = countsOf(items)
            const isFocused = cell.date === focusedDate
            const classes = ['cal-day']
            if (!cell.inMonth) classes.push('cal-day--out')
            if (cell.isToday) classes.push('cal-day--today')
            if (cell.date === selectedDate) classes.push('cal-day--selected')

            return (
              <div
                role="gridcell"
                key={cell.date}
                aria-selected={cell.date === selectedDate}
                data-date={cell.date}
              >
                <button
                  type="button"
                  className={classes.join(' ')}
                  tabIndex={isFocused ? 0 : -1}
                  aria-current={cell.isToday ? 'date' : undefined}
                  aria-label={`${formatLongDate(cell.date)}, ${summaryOf(counts.events, counts.reminders)}`}
                  ref={element => {
                    if (element) buttons.current.set(cell.date, element)
                    else buttons.current.delete(cell.date)
                  }}
                  onFocus={() => {
                    if (cell.date !== focusedDate) onFocusDate(cell.date)
                  }}
                  onClick={() => onOpenDate(cell.date)}
                >
                  <span className="cal-day__num">{cell.day}</span>
                  <span className="cal-day__marks" aria-hidden="true">
                    {Array.from({ length: Math.min(counts.events, MAX_DOTS) }, (_unused, index) => (
                      <span
                        className={
                          counts.onlyYou && index === 0 ? 'cal-dot cal-dot--only' : 'cal-dot'
                        }
                        key={`dot-${index}`}
                      />
                    ))}
                    {Array.from(
                      { length: Math.min(counts.reminders, MAX_MARKS) },
                      (_unused, index) => (
                        <span
                          className={
                            index < counts.openReminders ? 'cal-mark' : 'cal-mark cal-mark--done'
                          }
                          key={`mark-${index}`}
                        />
                      ),
                    )}
                  </span>
                  {counts.events > MAX_DOTS ? (
                    <span className="cal-day__more" aria-hidden="true">
                      {`+${counts.events - MAX_DOTS}`}
                    </span>
                  ) : null}
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export default MonthGrid
