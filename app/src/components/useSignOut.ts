/*
 * Ending a session, in one place.
 *
 * There are two ways out of the app — the profile menu in the ShellBar and the Session card
 * in Settings — and exactly one of them being subtly different from the other is the kind
 * of bug nobody finds until somebody believes they signed out and did not. So the behaviour
 * lives here and both call it.
 *
 * Two decisions it encodes:
 *
 *  - **Success navigates rather than re-rendering.** The session cookie is `httpOnly`, so
 *    the SPA cannot confirm it is gone by reading it, and a react-query cache full of the
 *    household's postings should not outlive the person who fetched it. A full navigation
 *    drops both and makes `AuthGate` ask the server from scratch.
 *  - **Failure does not navigate.** Showing the login screen while the server-side session
 *    is still valid looks like success and is the worst of the three outcomes. The caller
 *    gets a finished sentence to render instead.
 */
import { useCallback, useState } from 'react'
import { AuthError, logout } from '@/api/auth'

export interface SignOut {
  /** Ends the session and navigates to `/`. Safe to call twice; the second is ignored. */
  signOut: () => void
  /** True from the click until either the navigation or the error. */
  busy: boolean
  /** A finished sentence, safe to render as-is, or `null`. */
  problem: string | null
}

export function useSignOut(): SignOut {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const signOut = useCallback((): void => {
    if (busy) return
    setBusy(true)
    setProblem(null)

    void logout()
      .then(() => {
        window.location.assign('/')
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setProblem(
          cause instanceof AuthError
            ? cause.message
            : 'Could not reach the server to sign out. Check your connection and try again.',
        )
      })
  }, [busy])

  return { signOut, busy, problem }
}
