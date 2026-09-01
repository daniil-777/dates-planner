/*
 * Who is signed in, and the way out.
 *
 * `logout()` has existed in `src/api/auth.ts` since the sign-in screen was written, and
 * until now nothing called it — so a session, which lasts a week, could only be ended by
 * clearing the browser's cookies. That is also why nobody had seen the welcome animation:
 * it fires on a fresh sign-in, and there was no way to reach one.
 *
 * Signing out reloads rather than re-rendering. The cookie is `httpOnly`, so the SPA cannot
 * confirm it is gone by reading it, and a react-query cache full of the household's
 * postings should not survive the person who fetched it — a full navigation drops both and
 * lets `AuthGate` ask the server from scratch. It is the honest way to end a session, and
 * on this app it costs one cached page load.
 */
import { useEffect, useState } from 'react'
import { Button, MessageStrip } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/log.js'
import { me, type AuthUser } from '@/api/auth'
import { useSignOut } from '@/components/useSignOut'
import { useI18n } from '@/i18n'
import { SettingsCard } from './SettingsCard'

export function SessionCard() {
  const [user, setUser] = useState<AuthUser | null>(null)
  // Shared with the ShellBar's profile menu — see components/useSignOut.ts.
  const { signOut, busy, problem } = useSignOut()
  const { t } = useI18n()

  useEffect(() => {
    let live = true
    // `/api/auth/me` always answers 200, so a failure here is a network problem rather than
    // a signed-out state. Either way the button below still works.
    void me()
      .then(found => {
        if (live) setUser(found)
      })
      .catch(() => {
        /* The card degrades to "you are signed in" without a name. */
      })
    return () => {
      live = false
    }
  }, [])

  const name = user?.displayName ?? user?.username ?? null

  return (
    <SettingsCard
      icon="log"
      title={t('settings.session.title', 'Session')}
      subtitle={t(
        'settings.session.subtitle',
        'Who this browser is signed in as, and how to stop being signed in.',
      )}
    >
      <p className="twm-settings-intro">
        {name === null
          ? t('settings.session.anonymous', 'This browser has a session on the ledger.')
          : t(
              'settings.session.signedInAs',
              'Signed in as {name}. Sessions last a week, on this browser only.',
              { name },
            )}
      </p>

      {problem === null ? null : (
        <MessageStrip design="Negative" hideCloseButton>
          {problem}
        </MessageStrip>
      )}

      <Button design="Transparent" icon="log" disabled={busy} onClick={signOut}>
        {busy ? t('shell.signingout', 'Signing out…') : t('shell.signout', 'Sign out')}
      </Button>
    </SettingsCard>
  )
}

export default SessionCard
