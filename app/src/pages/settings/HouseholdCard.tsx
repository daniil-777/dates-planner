/**
 * The household this ledger belongs to — who is in it, how to let somebody else in, and
 * how to look at a different one.
 *
 * Until now a household could only be created during sign-up, and its invitation code was
 * shown exactly once on the way past. That is fine for the first person and useless for the
 * second: the code lasts three days and is rotated the moment somebody joins, so the owner
 * needs somewhere to ask for a fresh one. This is that somewhere.
 *
 * ## Why the code is not simply on screen
 *
 * It is an open door: anyone holding it joins and sees every receipt, memory and message.
 * So it is fetched on request rather than rendered with the page, which keeps it out of a
 * screenshot taken for some other reason, and out of the DOM of a phone handed across a
 * table. Owners only — the server enforces that too, and this hides the control rather than
 * offering one that will 403.
 */
import { useEffect, useState } from 'react'
import { Button, MessageStrip } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/group.js'
import '@ui5/webcomponents-icons/dist/add-employee.js'
import '@ui5/webcomponents-icons/dist/synchronize.js'

import {
  invitation,
  session as fetchSession,
  switchHousehold,
  type Membership,
  type Session,
} from '@/api/auth'
import { SettingsCard } from './SettingsCard'

/** Presets are copy, not behaviour — this is the copy. */
const KIND_LABEL: Record<string, string> = {
  couple: 'Just the two of us',
  household: 'A household',
  friends: 'Friends',
  family: 'Family',
  other: 'A group',
}

/** "Just the two of us · you are Ada · owner", with the parts that are missing left out. */
function describe(session: Session): string {
  const parts = [
    KIND_LABEL[session.kind ?? ''] ?? null,
    session.personName === null ? null : `you are ${session.personName}`,
    session.role === 'owner' ? 'owner' : null,
  ]
  return parts.filter((part): part is string => part !== null).join(' · ')
}

export function HouseholdCard() {
  const [session, setSession] = useState<Session | null>(null)
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void fetchSession()
      .then(found => {
        if (live) setSession(found)
      })
      .catch(() => {
        // The card simply does not appear; every other setting still works.
      })
    return () => {
      live = false
    }
  }, [])

  // A session from the configured AUTH_* logins has no account behind it and therefore no
  // household to manage. Showing an empty card there would raise a question with no answer.
  if (session === null || session.groupId === null) return null

  async function show(rotate: boolean): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      setInvite(await invitation(rotate))
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'The code could not be fetched.')
    } finally {
      setBusy(false)
    }
  }

  async function moveTo(membership: Membership): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      await switchHousehold(membership.groupId)
      // A full navigation, for the same reason signing out does one: every cached query
      // holds the previous household's postings, and no amount of invalidation is as
      // certain as starting again.
      window.location.assign('/')
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'That did not work.')
      setBusy(false)
    }
  }

  const others = session.memberships.filter(row => row.groupId !== session.groupId)

  return (
    <SettingsCard
      icon="group"
      title={session.groupName ?? 'Your household'}
      subtitle={describe(session)}
    >
      {problem !== null && (
        <MessageStrip design="Negative" hideCloseButton>
          {problem}
        </MessageStrip>
      )}

      {session.role === 'owner' && (
        <div className="household__invite">
          {invite === null ? (
            <Button
              icon="add-employee"
              design="Emphasized"
              disabled={busy}
              onClick={() => void show(false)}
            >
              Invite somebody
            </Button>
          ) : (
            <>
              <p
                className="household__code"
                aria-label={`Invitation code ${invite.code.split('').join(' ')}`}
              >
                {invite.code}
              </p>
              <p className="household__note">
                Works once, and until {new Date(invite.expiresAt).toLocaleDateString()}. Whoever
                types it sees everything in this ledger.
              </p>
              <Button icon="synchronize" disabled={busy} onClick={() => void show(true)}>
                Replace it
              </Button>
            </>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="household__others">
          <p className="household__othersLabel">Also in</p>
          {others.map(membership => (
            <Button
              key={membership.groupId}
              design="Transparent"
              disabled={busy}
              onClick={() => void moveTo(membership)}
            >
              {membership.groupName}
            </Button>
          ))}
        </div>
      )}
    </SettingsCard>
  )
}

export default HouseholdCard
