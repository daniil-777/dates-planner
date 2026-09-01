/**
 * Anniversary reminders.
 *
 * Two rules, both deliberate: permission is only ever requested from an
 * explicit tap (browsers punish load-time prompts, and so do people), and a
 * reminder for a given anniversary fires at most once, tracked in
 * localStorage by anniversary id and date.
 *
 * These are local notifications, so they fire while the app is open — which,
 * as an installed PWA people check on the way home, is often enough. Real
 * push would need a server holding subscriptions and a VAPID key pair, which
 * is a lot of infrastructure for one household and one date a year.
 */

import type { Anniversary } from './anniversaries'
import { formatLongDate, ordinal } from './dates'

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied'

const OPT_IN_KEY = 'twm.memories.anniversaryReminders'
const SENT_KEY = 'twm.memories.anniversarySent'
/** Fire the reminder on the day itself and a week ahead. */
export const REMINDER_DAYS = [0, 7]

function hasNotificationApi(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function'
}

export function notificationState(): NotificationState {
  if (!hasNotificationApi()) return 'unsupported'
  const permission = window.Notification.permission
  if (permission === 'granted' || permission === 'denied') return permission
  return 'default'
}

/** Call this from a click handler only. */
export async function requestNotificationPermission(): Promise<NotificationState> {
  if (!hasNotificationApi()) return 'unsupported'
  try {
    const permission = await window.Notification.requestPermission()
    return permission === 'granted' || permission === 'denied' ? permission : 'default'
  } catch {
    return 'default'
  }
}

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
    // Storage is unavailable; the reminder simply may repeat next session.
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

export function reminderText(anniversary: Anniversary): { title: string; body: string } {
  const which = ordinal(anniversary.years)
  const when = anniversary.daysUntil === 0 ? 'is today' : `is in ${anniversary.daysUntil} days`
  return {
    title:
      anniversary.source === 'document-one'
        ? `Document #1 — ${which} anniversary`
        : `${anniversary.title} — ${which} anniversary`,
    body: `${formatLongDate(anniversary.nextDate)} ${when}.`,
  }
}

/**
 * Fires the reminders that are due, once each. Safe to call on every render
 * pass of the page: everything it does is idempotent.
 */
export function notifyDueAnniversaries(anniversaries: readonly Anniversary[]): number {
  if (!isOptedIn() || notificationState() !== 'granted') return 0

  const marks = sentMarks()
  let fired = 0

  for (const anniversary of anniversaries) {
    if (!REMINDER_DAYS.includes(anniversary.daysUntil)) continue
    const mark = `${anniversary.ID}@${anniversary.nextDate}#${anniversary.daysUntil}`
    if (marks[mark]) continue
    const { title, body } = reminderText(anniversary)
    try {
      new window.Notification(title, { body, tag: mark })
      marks[mark] = true
      fired += 1
    } catch {
      // Some browsers only allow notifications through a service worker
      // registration. Not worth failing the page over.
      return fired
    }
  }

  if (fired > 0) writeFlag(SENT_KEY, JSON.stringify(marks))
  return fired
}
