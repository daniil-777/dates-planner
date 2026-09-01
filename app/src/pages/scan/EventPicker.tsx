import { Option, Select, Text, type SelectPropTypes } from '@ui5/webcomponents-react'
import { EventChip } from '../../components/EventChip'
import type { Event } from '../../api/types'

interface EventPickerProps {
  events: Event[]
  selected: string | null
  onSelect: (eventId: string | null) => void
}

/** The sentinel `Option` value for "no event", since a `Select` cannot carry null. */
const NONE = ''

/**
 * Which trip, dinner or party this posting belongs to — or none at all.
 *
 * An expense with no event is ordinary spending (CONTRACTS.md §10), which is the common
 * case and therefore the default. Choosing an event files the amount under that occasion
 * as well as under the month; it never divides it between anybody, and the chip below the
 * select says what was chosen rather than what anyone now has to pay.
 */
export function EventPicker({ events, selected, onSelect }: EventPickerProps) {
  const chosen = events.find(event => event.ID === selected) ?? null

  const handleChange: SelectPropTypes['onChange'] = event => {
    const value = event.detail.selectedOption.value ?? NONE
    onSelect(value === NONE ? null : value)
  }

  if (events.length === 0) {
    return (
      <Text className="scan-field-note" data-testid="scan-event">
        No events yet — postings are filed as everyday spending.
      </Text>
    )
  }

  return (
    <div className="scan-event" data-testid="scan-event">
      <Select accessibleName="Event" onChange={handleChange}>
        <Option value={NONE} selected={chosen === null}>
          Everyday spending
        </Option>
        {events.map(event => (
          <Option key={event.ID} value={event.ID} selected={event.ID === chosen?.ID}>
            {event.name}
          </Option>
        ))}
      </Select>
      {chosen ? <EventChip event={chosen} onClear={() => onSelect(null)} /> : null}
    </div>
  )
}
