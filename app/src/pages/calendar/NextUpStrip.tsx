/**
 * "Next up" — the nearest open reminder, with a countdown, above the month.
 *
 * The strip reads every reminder there is rather than the ones in the month on screen:
 * paging to March must not make the nudge due on Tuesday disappear.
 *
 * The notification opt-in lives here and is a button, nothing else. `requestPermission`
 * is imported from the Memories implementation and is only ever called from this click
 * handler — never on mount. Browsers hold a load-time prompt against a site permanently
 * (CONTRACTS §11.2).
 */

import { useEffect, useState } from 'react'
import { Button, Icon, Text } from '@ui5/webcomponents-react'
import type { Reminder } from '@/api/types'
import { formatLongDate } from '../memories/dates'
import type { NextReminder } from './entries'
import { countdownLabel, leadLabel, reminderTitle } from './entries'
import {
  isOptedIn,
  notificationState,
  notifyDueReminders,
  requestNotificationPermission,
  setOptedIn,
  type NotificationState,
} from './notifications'

export interface NextUpStripProps {
  next: NextReminder | null
  /** Every reminder, so a nudge that is due can fire even for a month not on screen. */
  reminders: readonly Reminder[]
  onOpenEvent: (eventId: string) => void
  onComplete: (id: string) => void
  onCreate: () => void
  busyId: string | null
}

function hintFor(permission: NotificationState, optedIn: boolean): string {
  if (permission === 'unsupported') return 'This browser cannot show reminders.'
  if (permission === 'denied') return 'Reminders are blocked in the browser settings.'
  if (permission === 'granted' && optedIn) return 'Nudges on — on the day a reminder is due.'
  return 'Get a nudge on the day a reminder is due.'
}

export function NextUpStrip({
  next,
  reminders,
  onOpenEvent,
  onComplete,
  onCreate,
  busyId,
}: NextUpStripProps) {
  const [permission, setPermission] = useState<NotificationState>(() => notificationState())
  const [optedIn, setOptIn] = useState<boolean>(() => isOptedIn())

  useEffect(() => {
    if (!optedIn || permission !== 'granted') return
    notifyDueReminders(reminders)
  }, [reminders, optedIn, permission])

  const enable = async (): Promise<void> => {
    const state = await requestNotificationPermission()
    setPermission(state)
    const on = state === 'granted'
    setOptedIn(on)
    setOptIn(on)
  }

  const disable = (): void => {
    setOptedIn(false)
    setOptIn(false)
  }

  const countLabel = next === null ? '—' : next.overdue ? '!' : String(Math.abs(next.daysUntil))
  const unitLabel =
    next === null
      ? 'nothing'
      : next.overdue
        ? 'overdue'
        : next.daysUntil === 0
          ? 'today'
          : next.daysUntil === 1
            ? 'day'
            : 'days'

  const classes = ['cal-next']
  if (next?.overdue) classes.push('cal-next--overdue')

  return (
    <section className={classes.join(' ')} aria-label="Next reminder" data-testid="next-up">
      <div className="cal-next__row">
        <div className="cal-next__count" aria-hidden="true">
          <span className="cal-next__days">{countLabel}</span>
          <span className="cal-next__unit">{unitLabel}</span>
        </div>

        {next === null ? (
          <div className="cal-next__body">
            <span className="cal-label">Next up</span>
            <span className="cal-next__title">No reminders</span>
            <Text className="cal-label">
              A reminder fires a few days before an event, so the sleeper gets booked.
            </Text>
          </div>
        ) : (
          <div className="cal-next__body">
            <span className="cal-label">
              {next.overdue ? 'Was due' : 'Next up'} · {countdownLabel(next.daysUntil)}
            </span>
            <span className="cal-next__title">{reminderTitle(next.reminder)}</span>
            <Text className="cal-label">
              {[
                next.reminder.eventName,
                leadLabel(next.reminder.leadDays),
                formatLongDate(next.reminder.dueOn),
              ]
                .filter(part => typeof part === 'string' && part.length > 0)
                .join(' · ')}
            </Text>
          </div>
        )}

        {next === null ? (
          <Button design="Emphasized" icon="add" onClick={onCreate}>
            New reminder
          </Button>
        ) : (
          <>
            <Button
              design="Transparent"
              icon="accept"
              disabled={busyId === next.reminder.ID}
              accessibleName={`Mark “${reminderTitle(next.reminder)}” done`}
              tooltip="Done"
              onClick={() => onComplete(next.reminder.ID)}
            />
            <Button
              design="Transparent"
              icon="navigation-right-arrow"
              disabled={!next.reminder.event_ID}
              accessibleName={`Open ${next.reminder.eventName ?? 'the event'}`}
              tooltip="Open the event"
              onClick={() => {
                if (next.reminder.event_ID) onOpenEvent(next.reminder.event_ID)
              }}
            />
          </>
        )}
      </div>

      <div className="cal-next__foot">
        <Icon name="bell" aria-hidden="true" />
        <Text className="cal-label">{hintFor(permission, optedIn)}</Text>
        {permission === 'granted' && optedIn ? (
          <Button design="Transparent" onClick={disable}>
            Turn off
          </Button>
        ) : permission === 'unsupported' || permission === 'denied' ? null : (
          <Button design="Transparent" icon="bell" onClick={() => void enable()}>
            Nudge me
          </Button>
        )}
      </div>
    </section>
  )
}

export default NextUpStrip
