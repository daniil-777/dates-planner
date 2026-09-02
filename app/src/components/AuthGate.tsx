/**
 * The gate between the login card and the app.
 *
 * It asks `/api/auth/me` **once** on mount and then renders one of three things: a centred
 * spinner while it is deciding, the app when the cookie names somebody, and the login page
 * when it does not. After a successful sign-in it asks again rather than trusting the
 * response it already has — the session the app runs under is the one the *server* agrees
 * to, and re-checking is one cheap request that removes a whole class of "logged in on the
 * client only" bugs.
 *
 * What it deliberately does not do is navigate. No `window.location`, no reload: a hard
 * redirect would throw away the PWA shell — the cached bundle, the query cache, the scroll
 * position, and offline capability with them — to show a screen this component can simply
 * render in place.
 *
 * A server that cannot be reached is treated as "not signed in", but its sentence is passed
 * down to the card, so a person sees "could not reach the server" rather than silently
 * being asked for a password that was never going to be checked.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AuthError, session } from '@/api/auth'
import { Onboarding } from '@/pages/login/Onboarding'
import { BrandMark } from '@/pages/login/BrandMark'
import { LoginPage } from '@/pages/LoginPage'
import { WelcomeFireworks } from '@/components/WelcomeFireworks'
import '@/pages/login/login.css'

export interface AuthGateProps {
  children: ReactNode
  /** Rendered instead of the app while the first `me()` is in flight. */
  fallback?: ReactNode
}

/**
 * `homeless` is signed in with no household yet — the state registration leaves you in,
 * and the only one where the app itself has nothing to show. Without it the ledger renders
 * empty and looks broken rather than unfinished.
 */
type Phase = 'checking' | 'authenticated' | 'homeless' | 'anonymous'

/** The centred spinner. Static under `prefers-reduced-motion` — see `login.css`. */
function Deciding() {
  return (
    <div className="login-deciding" role="status" aria-live="polite">
      <div className="login-deciding__ring" aria-hidden="true" />
      <span className="login-deciding__label">Checking your session…</span>
    </div>
  )
}

export function AuthGate({ children, fallback }: AuthGateProps) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * Set only by {@link handleAuthenticated} — the callback `LoginPage` fires after a
   * successful sign-in — and never by the mount-time check. That is the whole distinction
   * between "you just signed in" and "you reloaded a page you were already signed into",
   * and it is why a refresh does not set off fireworks.
   */
  const [celebrate, setCelebrate] = useState(false)
  // Guards against StrictMode's double-invoked mount effect: one check, one request.
  const asked = useRef(false)

  const check = useCallback(async (): Promise<void> => {
    setPhase('checking')
    try {
      const found = await session()
      setNotice(null)
      if (!found.authenticated) {
        setPhase('anonymous')
      } else if (found.userId !== null && found.groupId === null) {
        // An account exists but belongs to nowhere. A session from the configured AUTH_*
        // logins has no `userId` at all and is not caught here — it has always meant the
        // seeded household, and still does.
        setPhase('homeless')
      } else {
        setPhase('authenticated')
      }
    } catch (cause) {
      // Unreachable or broken: show the card, and say why rather than pretending.
      setNotice(
        cause instanceof AuthError
          ? cause.message
          : 'Could not reach the server. Check your connection and try again.',
      )
      setPhase('anonymous')
    }
  }, [])

  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void check()
  }, [check])

  const handleAuthenticated = useCallback((): void => {
    setCelebrate(true)
    void check()
  }, [check])

  if (phase === 'checking') return <>{fallback ?? <Deciding />}</>

  if (phase === 'homeless') {
    return (
      <div className="login">
        <main className="login__card">
          <header className="login__head">
            <BrandMark className="login__mark" />
            <h1 className="login__title">One more thing</h1>
            <p className="login__tagline">A ledger needs a household to belong to.</p>
          </header>
          <Onboarding step="household" onReady={() => void check()} />
        </main>
      </div>
    )
  }

  // The app renders underneath from the first frame, so the three seconds are spent on a
  // loaded page rather than in front of one. The overlay takes no pointer events, so a tap
  // that lands during it reaches whatever it was aimed at.
  if (phase === 'authenticated') {
    return (
      <>
        {children}
        {celebrate ? <WelcomeFireworks onDone={() => setCelebrate(false)} /> : null}
      </>
    )
  }

  return <LoginPage notice={notice} onAuthenticated={handleAuthenticated} />
}

export default AuthGate
