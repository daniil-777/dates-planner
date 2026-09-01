/**
 * The sign-in screen — the first thing anybody sees, so it is the product, not a form.
 *
 * Three decisions worth knowing about:
 *
 *  1. **Plain HTML, not UI5 web components.** This screen can be the first paint of the
 *     PWA, before the theme's custom elements have upgraded; a native `<input>` and
 *     `<button>` are legible and submittable at that moment, and a custom element that has
 *     not upgraded yet is a blank box. Colours still come from the Horizon parameters
 *     (see `login/login.css`), so it follows light and dark with the rest of the app.
 *  2. **It renders, it never navigates.** No `window.location`, no router push — this
 *     component is what `AuthGate` shows *instead of* the app. Losing the shell to a hard
 *     redirect would cost the PWA its cached bundle and its scroll position, and would make
 *     a failed login look like a crash.
 *  3. **Errors are sentences in the card.** Never an `alert()`, never a status code: the
 *     only thing a wrong password should produce is one line under the fields that says the
 *     username and password did not match — deliberately the same line whether the account
 *     exists or not.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { AuthError, login, type AuthUser } from '@/api/auth'
import { BrandMark } from './login/BrandMark'
import { AlertIcon, EyeIcon, EyeOffIcon, ShieldIcon } from './login/icons'
import './login/login.css'

export interface LoginPageProps {
  /** Called once the cookie is set. `AuthGate` re-checks the session from here. */
  onAuthenticated?: (user: AuthUser) => void
  /**
   * A message the gate already knows about — "the server could not be reached", say —
   * shown until the person tries a sign-in of their own.
   */
  notice?: string | null
}

/** The fallback sentence for a rejection that is not an `AuthError`. */
const UNEXPECTED = 'Could not sign in. Try again.'

export function LoginPage({ onAuthenticated, notice = null }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Autofocus the first field. Done here rather than with the `autoFocus` attribute so it
  // also happens when the gate swaps this page in after a session expires mid-session.
  useEffect(() => {
    usernameRef.current?.focus()
  }, [])

  const usernameId = useId()
  const passwordId = useId()
  const messageId = useId()

  // The gate's notice is shown until the person's own attempt produces something to say.
  const message = error ?? notice

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) return

    const name = username.trim()
    if (name.length === 0 || password.length === 0) {
      setError('Enter your username and password.')
      ;(name.length === 0 ? usernameRef : passwordRef).current?.focus()
      return
    }

    setBusy(true)
    setError(null)
    try {
      const user = await login(name, password)
      onAuthenticated?.(user)
    } catch (cause) {
      setError(cause instanceof AuthError ? cause.message : UNEXPECTED)
      // Put the caret back where the correction is most likely to be made. The value is
      // left in place: retyping a long password because of one typo in the username is a
      // small cruelty, and the field is masked anyway.
      passwordRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <main className="login__card">
        <header className="login__head">
          <BrandMark className="login__mark" />
          <h1 className="login__title">Two-Way Match</h1>
          <p className="login__tagline">Date management for two</p>
        </header>

        <form className="login__form" onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <label className="login-field__label" htmlFor={usernameId}>
              Username
            </label>
            <div className="login-field__box">
              <input
                id={usernameId}
                ref={usernameRef}
                className="login-field__input"
                type="text"
                name="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                aria-invalid={error !== null}
                aria-describedby={message === null ? undefined : messageId}
              />
            </div>
          </div>

          <div className="login-field">
            <label className="login-field__label" htmlFor={passwordId}>
              Password
            </label>
            <div className="login-field__box">
              <input
                id={passwordId}
                ref={passwordRef}
                className="login-field__input login-field__input--withToggle"
                type={revealed ? 'text' : 'password'}
                name="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                aria-invalid={error !== null}
                aria-describedby={message === null ? undefined : messageId}
              />
              <button
                type="button"
                className="login-field__toggle"
                onClick={() => setRevealed(current => !current)}
                aria-pressed={revealed}
                aria-controls={passwordId}
                aria-label={revealed ? 'Hide password' : 'Show password'}
                title={revealed ? 'Hide password' : 'Show password'}
              >
                {revealed ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>

          {message !== null && (
            <p className="login__error" id={messageId} role="alert">
              <AlertIcon />
              <span>{message}</span>
            </p>
          )}

          <button type="submit" className="login__submit" disabled={busy} aria-busy={busy}>
            {busy && <span className="login__spin" aria-hidden="true" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="login__note">
            <ShieldIcon />
            <span>
              Remember me for 7 days — that is how long this device stays signed in. Signing out
              ends it sooner.
            </span>
          </p>
        </form>
      </main>

      <p className="login__footer">Two-Way Match · a joint venture, audited internally</p>
    </div>
  )
}

export default LoginPage
