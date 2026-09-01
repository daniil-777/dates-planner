/**
 * The countdown card: how long until the next yearly recurrence of a pinned
 * memory or of Document #1, plus the reminder opt-in.
 *
 * The opt-in is a button and nothing else. `Notification.requestPermission()`
 * is never called on mount — browsers hold that against a site permanently,
 * and being asked for push access by an expense tracker before you have even
 * scrolled is exactly the behaviour this app is making fun of.
 */

import { useEffect, useState } from 'react'
import { Button, Icon, Text } from '@ui5/webcomponents-react'
import type { Anniversary } from './anniversaries'
import { daysUntilLabel, formatLongDate, ordinal } from './dates'
import {
  isOptedIn,
  notificationState,
  notifyDueAnniversaries,
  requestNotificationPermission,
  setOptedIn,
  type NotificationState,
} from './notifications'

export interface AnniversaryCardProps {
  anniversaries: readonly Anniversary[]
  onOpen: (anniversary: Anniversary) => void
}

function reminderHint(permission: NotificationState, optedIn: boolean): string {
  if (permission === 'unsupported') return 'This browser cannot show reminders.'
  if (permission === 'denied') return 'Reminders are blocked in the browser settings.'
  if (permission === 'granted' && optedIn) return 'Reminders on — a week ahead and on the day.'
  return 'Get a nudge a week ahead and on the day.'
}

export function AnniversaryCard({ anniversaries, onOpen }: AnniversaryCardProps) {
  const [permission, setPermission] = useState<NotificationState>(() => notificationState())
  const [optedIn, setOptIn] = useState<boolean>(() => isOptedIn())

  const next = anniversaries.length > 0 ? anniversaries[0] : null
  const upcoming = anniversaries.slice(1, 4)

  useEffect(() => {
    if (!optedIn || permission !== 'granted') return
    notifyDueAnniversaries(anniversaries)
  }, [anniversaries, optedIn, permission])

  if (!next) return null

  const enableReminders = async () => {
    const state = await requestNotificationPermission()
    setPermission(state)
    const on = state === 'granted'
    setOptedIn(on)
    setOptIn(on)
  }

  const disableReminders = () => {
    setOptedIn(false)
    setOptIn(false)
  }

  const countLabel = next.daysUntil === 0 ? '♥' : String(next.daysUntil)
  const unitLabel = next.daysUntil === 0 ? 'today' : next.daysUntil === 1 ? 'day' : 'days'

  return (
    <section className="tw-card tw-anniversary" aria-label="Next anniversary">
      <div className="tw-anniversary__row">
        <div className="tw-anniversary__count" aria-hidden="true">
          <span className="tw-anniversary__days">{countLabel}</span>
          <span className="tw-anniversary__unit">{unitLabel}</span>
        </div>
        <div className="tw-anniversary__body">
          <span className="tw-label">
            Next anniversary {next.daysUntil === 0 ? 'is today' : `in ${next.daysUntil} days`}
          </span>
          <span className="tw-anniversary__title">
            {next.source === 'document-one' ? 'Document #1' : next.title}
          </span>
          <Text className="tw-label">
            {ordinal(next.years)} · {formatLongDate(next.nextDate)}
            {next.place ? ` · ${next.place}` : ''}
          </Text>
        </div>
        <Button
          design="Transparent"
          icon="journey-arrive"
          accessibleName={`Open ${next.title}`}
          tooltip="Open"
          onClick={() => onOpen(next)}
        />
      </div>

      {upcoming.length > 0 && (
        <div className="tw-anniversary__more">
          {upcoming.map(anniversary => (
            <Button
              key={`${anniversary.ID}-${anniversary.nextDate}`}
              design="Transparent"
              onClick={() => onOpen(anniversary)}
            >
              {`${anniversary.title} · ${daysUntilLabel(anniversary.daysUntil)}`}
            </Button>
          ))}
        </div>
      )}

      <div className="tw-anniversary__foot">
        <Icon name="bell" aria-hidden="true" />
        <Text className="tw-label">{reminderHint(permission, optedIn)}</Text>
        {permission === 'granted' && optedIn ? (
          <Button design="Transparent" onClick={disableReminders}>
            Turn off
          </Button>
        ) : permission === 'unsupported' || permission === 'denied' ? null : (
          <Button design="Emphasized" icon="bell" onClick={() => void enableReminders()}>
            Remind me
          </Button>
        )}
      </div>
    </section>
  )
}
