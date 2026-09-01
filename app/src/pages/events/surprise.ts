/**
 * Surprises, on the client — the reading half of CONTRACTS.md §11.3.
 *
 * The important thing about this file is how little it does. The *hiding* happens on the
 * server: `LedgerService` narrows every read of `Events`, `EventParticipants`, `EventPhotos`
 * and `Reminders` so that a surprise somebody else is planning never reaches this browser at
 * all. There is deliberately no client-side filter here, because a filter would imply the
 * data had arrived and merely been hidden from view — which is precisely the leak the server
 * rule exists to prevent. What is left for the UI is one decision: whether to draw the
 * discreet "Only you can see this" badge and offer Reveal.
 *
 * `isStillSecret` mirrors `isSecret` in `srv/ledger-service.ts` line for line, including the
 * day-of rule: a surprise stops being one the moment its own first day arrives, because by
 * then there is nothing left to spoil — and an event that stayed hidden through its own
 * opening day would be missing from the calendar on the one day it mattered. If that rule
 * ever changes it must change in both places; the badge appearing on an event everybody can
 * already see is the failure mode, and it is a loud one.
 *
 * And a reminder of what is *not* hidden, in either place: the money. A hidden surprise's
 * postings stay in the ledger and in every total, exactly as ordinary spending. A gap in the
 * month's figure would give the game away far more surely than the event's name ever could.
 */

import type { Event, Person } from '@/api/types'
import { parseIsoDate, todayIso } from './dates'

/** The fields the secrecy rules actually read; anything shaped like this will do. */
export type SecretFields = Pick<Event, 'isSurprise' | 'revealedAt' | 'startsOn'>

/**
 * Is this event still a secret from *somebody*?
 *
 * Mirrors `isSecret` on the server. An event whose `startsOn` cannot be read has no day that
 * can arrive, so only an explicit reveal opens it — the same fail-closed choice the backend
 * makes, for the same reason.
 */
export function isStillSecret(event: SecretFields, today: string = todayIso()): boolean {
  if (event.isSurprise !== true) return false
  if (event.revealedAt) return false
  const startsOn = parseIsoDate(event.startsOn)
  return startsOn === null || event.startsOn > today
}

/**
 * Who "you" are, for the purposes of the badge.
 *
 * The shell's person switcher is a preference on the device rather than an identity from the
 * server, so it is the closest thing this app has to "the person holding the phone". When
 * nothing has been chosen the roster's first `isDefault` person stands in — the same
 * fallback CONTRACTS §11.3 specifies for the backend, so the two sides agree about who is
 * looking as often as they possibly can.
 */
export function resolveViewer(
  activePerson: Person | null,
  people: readonly Person[],
): Person | null {
  if (activePerson) {
    // The switcher may still be holding somebody who has since left the roster; prefer the
    // live row so a renamed or recoloured person is drawn correctly.
    return people.find(person => person.ID === activePerson.ID) ?? activePerson
  }
  return people.find(person => person.isDefault) ?? people[0] ?? null
}

/**
 * Does this viewer get the "Only you can see this" badge?
 *
 * Only the creator, and only while the secret holds. An unattributed surprise, or one whose
 * creator is somebody other than the viewer, gets nothing: the server would not have sent it,
 * and if it somehow did, announcing "this is a secret" about another person's plan is the one
 * mistake this feature must not make.
 */
export function isOwnSecret(
  event: SecretFields & Pick<Event, 'createdBy_ID'>,
  viewer: Person | null,
  today: string = todayIso(),
): boolean {
  if (!isStillSecret(event, today)) return false
  const creator = event.createdBy_ID
  if (!creator || !viewer) return false
  return creator === viewer.ID
}

/**
 * Why the surprise switch cannot do anything any more, or null while it still can.
 *
 * The switch is not disabled to be strict; it is disabled because ticking it would be a lie.
 * Once `revealedAt` is stamped or the first day has arrived, `isSurprise` is a column nothing
 * reads — the server has already stopped treating the event as a secret.
 */
export function surpriseLock(
  event: Pick<Event, 'revealedAt' | 'startsOn'>,
  today: string = todayIso(),
): string | null {
  if (event.revealedAt) {
    return 'This one has been revealed already. A surprise can only be sprung once.'
  }
  const startsOn = parseIsoDate(event.startsOn)
  if (startsOn !== null && event.startsOn <= today) {
    return 'The day has arrived, so there is nothing left to keep quiet about.'
  }
  return null
}
