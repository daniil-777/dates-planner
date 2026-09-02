/**
 * Everything before the ledger: create an account, then start a household or join one.
 *
 * Rendered by `LoginPage` once somebody chooses something other than "sign in", and by
 * `AuthGate` when an account is signed in but belongs to no household yet — which is the
 * state registration leaves you in, and the only state where the app has nothing to show.
 *
 * ## The one design decision worth defending
 *
 * The brief asked for the sign-up to distinguish a man-and-woman couple from a same-sex
 * one. It does not, and the schema has nowhere to put it. Orientation is special-category
 * data under GDPR Article 9 and the Swiss FADP; nothing in this app — not the classifier,
 * not the totals, not the calendar — behaves differently for one couple than another, so
 * collecting it would mean holding the most sensitive field in the system for no purpose.
 * What the brief actually needs is the roster size and the voice, and "Just the two of us"
 * gives both. See `docs/ARCHITECTURE.md` section 6.
 */
import { useId, useState, type FormEvent } from 'react'

import {
  AuthError,
  createHousehold,
  joinHousehold,
  registerAccount,
  type GroupKind,
} from '../../api/auth'
import { AlertIcon, ShieldIcon } from './icons'

export type OnboardingStep = 'account' | 'household'

interface OnboardingProps {
  /** Where to begin. `household` is for an account that exists but has joined nothing. */
  step: OnboardingStep
  /** Called once there is both an account and a household — the app can take over. */
  onReady(): void
  /** Back to the sign-in form. Absent once an account exists, since there is no going back. */
  onCancel?: () => void
}

/**
 * The four presets.
 *
 * `kind` reaches the server and shapes copy and defaults; it never changes behaviour. The
 * hint under each is what the person is actually choosing between.
 */
const KINDS: ReadonlyArray<{ value: GroupKind; label: string; hint: string }> = [
  { value: 'couple', label: 'Just the two of us', hint: 'Two people, one ledger' },
  { value: 'household', label: 'A household', hint: 'Everyone under one roof' },
  { value: 'friends', label: 'Friends', hint: 'Trips and dinners together' },
  { value: 'family', label: 'Family', hint: 'Across more than one address' },
]

export function Onboarding({ step, onReady, onCancel }: OnboardingProps) {
  const [phase, setPhase] = useState<OnboardingStep>(step)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Account
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  // Household
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [householdName, setHouseholdName] = useState('')
  const [kind, setKind] = useState<GroupKind>('couple')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<string | null>(null)

  const emailId = useId()
  const passwordId = useId()
  const nameId = useId()
  const householdId = useId()
  const codeId = useId()
  const errorId = useId()

  async function attempt(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      // The server's wording is written for the person reading it — "there is already an
      // account for that address" says more than any generic line could.
      setError(cause instanceof AuthError ? cause.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function submitAccount(event: FormEvent): void {
    event.preventDefault()
    void attempt(async () => {
      await registerAccount({ email, password, displayName })
      setPhase('household')
    })
  }

  function submitHousehold(event: FormEvent): void {
    event.preventDefault()
    void attempt(async () => {
      if (mode === 'join') {
        await joinHousehold(code)
        onReady()
        return
      }
      const created = await createHousehold({ name: householdName, kind })
      // The code is shown once, here, before the app takes over. Rotating it later lives
      // in Settings; this is the moment somebody actually wants to read it out.
      setInvite(created.inviteCode)
    })
  }

  if (invite !== null) {
    return (
      <section className="login__form" aria-live="polite">
        <h2 className="onboard__title">Your household is ready</h2>
        <p className="onboard__lede">
          Give this code to whoever is joining you. It works once, and lasts three days.
        </p>
        <p className="onboard__code" aria-label={`Invitation code ${invite.split('').join(' ')}`}>
          {invite}
        </p>
        <button type="button" className="login__submit" onClick={onReady}>
          Take me in
        </button>
        <p className="login__note">
          <ShieldIcon />
          <span>You can show it again, or replace it, from Settings at any time.</span>
        </p>
      </section>
    )
  }

  if (phase === 'account') {
    return (
      <form className="login__form" onSubmit={submitAccount} noValidate>
        <h2 className="onboard__title">Create an account</h2>

        <Field id={nameId} label="Your name">
          <input
            id={nameId}
            className="login-field__input"
            value={displayName}
            onChange={event => setDisplayName(event.target.value)}
            autoComplete="name"
            enterKeyHint="next"
          />
        </Field>

        <Field id={emailId} label="Email">
          <input
            id={emailId}
            className="login-field__input"
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            aria-describedby={error === null ? undefined : errorId}
          />
        </Field>

        <Field id={passwordId} label="Password">
          <input
            id={passwordId}
            className="login-field__input"
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="new-password"
            enterKeyHint="go"
            aria-describedby={error === null ? undefined : errorId}
          />
        </Field>

        <ErrorLine id={errorId} message={error} />

        <button type="submit" className="login__submit" disabled={busy} aria-busy={busy}>
          {busy && <span className="login__spin" aria-hidden="true" />}
          {busy ? 'Creating…' : 'Create account'}
        </button>

        {onCancel !== undefined && (
          <button type="button" className="onboard__link" onClick={onCancel}>
            I already have one
          </button>
        )}
      </form>
    )
  }

  return (
    <form className="login__form" onSubmit={submitHousehold} noValidate>
      <h2 className="onboard__title">
        {mode === 'create' ? 'Start a household' : 'Join a household'}
      </h2>

      <div className="onboard__switch" role="tablist" aria-label="Start or join">
        {(['create', 'join'] as const).map(option => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={mode === option}
            className={`onboard__tab${mode === option ? ' onboard__tab--on' : ''}`}
            onClick={() => {
              setMode(option)
              setError(null)
            }}
          >
            {option === 'create' ? 'Start one' : 'Join one'}
          </button>
        ))}
      </div>

      {mode === 'create' ? (
        <>
          <Field id={householdId} label="What shall we call it?">
            <input
              id={householdId}
              className="login-field__input"
              value={householdName}
              onChange={event => setHouseholdName(event.target.value)}
              placeholder="Ada and Grace"
              enterKeyHint="next"
            />
          </Field>

          <fieldset className="onboard__kinds">
            <legend className="login-field__label">Who is it for?</legend>
            {KINDS.map(option => (
              <label
                key={option.value}
                className={`onboard__kind${kind === option.value ? ' onboard__kind--on' : ''}`}
              >
                <input
                  type="radio"
                  name="kind"
                  value={option.value}
                  checked={kind === option.value}
                  onChange={() => setKind(option.value)}
                />
                <span className="onboard__kindLabel">{option.label}</span>
                <span className="onboard__kindHint">{option.hint}</span>
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <Field id={codeId} label="Invitation code">
          <input
            id={codeId}
            className="login-field__input onboard__codeInput"
            value={code}
            onChange={event => setCode(event.target.value.toUpperCase())}
            placeholder="ABCD1234"
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-describedby={error === null ? undefined : errorId}
          />
        </Field>
      )}

      <ErrorLine id={errorId} message={error} />

      <button type="submit" className="login__submit" disabled={busy} aria-busy={busy}>
        {busy && <span className="login__spin" aria-hidden="true" />}
        {busy ? 'One moment…' : mode === 'create' ? 'Create it' : 'Join'}
      </button>
    </form>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="login-field">
      <label className="login-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="login-field__box">{children}</div>
    </div>
  )
}

function ErrorLine({ id, message }: { id: string; message: string | null }) {
  if (message === null) return null
  return (
    <p className="login__error" id={id} role="alert">
      <AlertIcon />
      <span>{message}</span>
    </p>
  )
}

export default Onboarding
