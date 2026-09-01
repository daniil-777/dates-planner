/**
 * Reminder nudges.
 *
 * The permission flow is **not** re-implemented here. `notificationState` and
 * `requestNotificationPermission` are imported verbatim from
 * `pages/memories/notifications.ts`, which already encodes the rule CONTRACTS §11.2
 * repeats: `Notification.requestPermission()` is called from a click handler and from
 * nowhere else. Browsers hold a load-time prompt against a site permanently, and an
 * expense tracker asking for push access before you have scrolled is exactly the
 * behaviour this app is making fun of. One implementation, two callers.
 *
 * What is local to the calendar is the opt-in flag and the sent-once bookkeeping, and
 * the flag is deliberately its own key rather than the Memories one: they are two
 * different subscriptions — an anniversary a year out and a "book the sleeper"
 * tomorrow — and turning reminders on from this page must not silently switch on
 * anniversary notifications on another. The browser permission behind them is shared,
 * because the browser only has one.
 *
 * These are local notifications: they fire while the app is open, which for an
 * installed PWA somebody checks on the way home is usually enough. Real push would
 * need a server holding subscriptions and a VAPID key pair — a lot of infrastructure
 * for one household.
 */

import type { Reminder } from '@/api/types'
import { diffInDays, formatLongDate, todayIso } from '../memories/dates'
import {
  notificationState,
  requestNotificationPermission,
  type NotificationState,
} from '../memories/notifications'
import { countdownLabel, reminderTitle } from './entries'

export { notificationState, requestNotificationPermission }
export type { NotificationState }

const OPT_IN_KEY = 'twm.calendar.reminderNudges'
const SENT_KEY = 'twm.calendar.reminderSent'

function readFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeFlag(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage is unavailable; a nudge may simply repeat next session.
  }
}

export function isOptedIn(): boolean {
  return readFlag(OPT_IN_KEY) === 'on'
}

export function setOptedIn(value: boolean): void {
  writeFlag(OPT_IN_KEY, value ? 'on' : 'off')
}

function sentMarks(): Record<string, true> {
  const raw = readFlag(SENT_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, true>
  } catch {
    return {}
  }
}

function reminderText(
  reminder: Reminder,
  daysUntil: number,
): {
  title: string
  body: string
} {
  const event = reminder.eventName ?? 'an event'
  return {
    title: reminderTitle(reminder),
    body:
      daysUntil === 0
        ? `${event} — today. Due ${formatLongDate(reminder.dueOn)}.`
        : `${event} — ${countdownLabel(daysUntil).toLowerCase()}. Due ${formatLongDate(reminder.dueOn)}.`,
  }
}

/**
 * Fires the reminders that have come due, once each.
 *
 * "Due" means `dueOn` is today or already past and the reminder is still open — a
 * reminder is a nudge before an event, so the day it lands is the day it is worth
 * saying something. Safe to call on every render: the mark is written per reminder
 * and per due day, so a reminder whose event moves is nudged again on its new day.
 */
export function notifyDueReminders(
  reminders: readonly Reminder[],
  today: string = todayIso(),
): number {
  if (!isOptedIn() || notificationState() !== 'granted') return 0

  const marks = sentMarks()
  let fired = 0

  for (const reminder of reminders) {
    if (reminder.done || !reminder.dueOn) continue
    if (reminder.dueOn > today) continue
    const mark = `${reminder.ID}@${reminder.dueOn}`
    if (marks[mark]) continue

    const { title, body } = reminderText(reminder, diffInDays(today, reminder.dueOn))
    try {
      new window.Notification(title, { body, tag: mark })
      marks[mark] = true
      fired += 1
    } catch {
      // Some browsers only allow notifications through a service worker registration.
      // Not worth failing the page over.
      break
    }
  }

  if (fired > 0) writeFlag(SENT_KEY, JSON.stringify(marks))
  return fired
}
