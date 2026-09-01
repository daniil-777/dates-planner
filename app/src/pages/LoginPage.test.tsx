/**
 * The login card, and the gate above it.
 *
 * Four things are worth pinning down here, and they are all things a person would notice:
 * the two fields exist and carry the autofill hints a password manager needs; a wrong
 * password produces one sentence inside the card and *nothing else* — no navigation, no
 * alert, no status code; a right one calls through with what was typed; and the reveal
 * toggle really flips the input's type rather than only its icon.
 *
 * `@/api/auth` is mocked with `importOriginal`, so `AuthError` stays the real class — the
 * page's `instanceof` check is part of what is under test.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from '@/components/AuthGate'
import { AuthError, parseUser, type AuthUser } from '@/api/auth'
import { LoginPage } from './LoginPage'

const login = vi.fn<(username: string, password: string) => Promise<AuthUser>>()
const me = vi.fn<() => Promise<AuthUser | null>>()

vi.mock('@/api/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/auth')>()
  return {
    ...actual,
    login: (username: string, password: string) => login(username, password),
    logout: () => Promise.resolve(),
    me: () => me(),
  }
})

const ADA: AuthUser = { username: 'ada', displayName: 'Ada' }

/** Fills both fields and presses Enter, which is how anybody actually signs in. */
function signIn(username = 'ada', password = 'correct horse'): void {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

beforeEach(() => {
  login.mockReset()
  me.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LoginPage', () => {
  it('renders both fields with the autofill hints and focuses the username', () => {
    render(<LoginPage />)

    const username = screen.getByLabelText('Username')
    const password = screen.getByLabelText('Password')

    expect(username).toHaveAttribute('autocomplete', 'username')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
    expect(password).toHaveAttribute('type', 'password')
    expect(username).toHaveFocus()

    // The product, not a generic form.
    expect(screen.getByRole('heading', { name: 'Two-Way Match' })).toBeInTheDocument()
    expect(screen.getByText('Spend management for two')).toBeInTheDocument()
    expect(screen.getByText(/Remember me for 7 days/)).toBeInTheDocument()
  })

  it('shows a failed login inline, with no alert and no navigation', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const href = window.location.href
    login.mockRejectedValue(new AuthError(401, 'That username and password did not match'))
    const onAuthenticated = vi.fn()

    render(<LoginPage onAuthenticated={onAuthenticated} />)
    signIn('ada', 'wrong')

    const problem = await screen.findByRole('alert')
    expect(problem).toHaveTextContent('That username and password did not match')
    expect(problem).not.toHaveTextContent('401')
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(window.location.href).toBe(href)
    // The form is usable again, with what was typed still in it.
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled()
    expect(screen.getByLabelText('Username')).toHaveValue('ada')
  })

  it('calls through on a successful login and reports the user', async () => {
    login.mockResolvedValue(ADA)
    const onAuthenticated = vi.fn()

    render(<LoginPage onAuthenticated={onAuthenticated} />)
    signIn('  ada  ', 'correct horse')

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(ADA))
    expect(login).toHaveBeenCalledWith('ada', 'correct horse')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('goes busy while the request is in flight, and refuses a second submit', async () => {
    let release: (user: AuthUser) => void = () => {}
    login.mockImplementation(() => new Promise<AuthUser>(resolve => (release = resolve)))

    render(<LoginPage />)
    signIn()

    const button = await screen.findByRole('button', { name: 'Signing in…' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(login).toHaveBeenCalledTimes(1)

    release(ADA)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled())
  })

  it('flips the password input type with the show/hide toggle', () => {
    render(<LoginPage />)
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('does not call the server when a field is empty', () => {
    render(<LoginPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(login).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your username and password.')
  })
})

describe('AuthGate', () => {
  it('renders the app once the session names somebody', async () => {
    me.mockResolvedValue(ADA)

    render(
      <AuthGate>
        <p>the ledger</p>
      </AuthGate>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…')
    expect(await screen.findByText('the ledger')).toBeInTheDocument()
    expect(me).toHaveBeenCalledTimes(1)
  })

  it('shows the login page, not the app, when nobody is signed in', async () => {
    me.mockResolvedValue(null)

    render(
      <AuthGate>
        <p>the ledger</p>
      </AuthGate>,
    )

    expect(await screen.findByLabelText('Username')).toBeInTheDocument()
    expect(screen.queryByText('the ledger')).not.toBeInTheDocument()
  })

  it('re-checks the session after a successful sign-in and then shows the app', async () => {
    me.mockResolvedValueOnce(null).mockResolvedValueOnce(ADA)
    login.mockResolvedValue(ADA)

    render(
      <AuthGate>
        <p>the ledger</p>
      </AuthGate>,
    )

    await screen.findByLabelText('Username')
    signIn()

    expect(await screen.findByText('the ledger')).toBeInTheDocument()
    expect(me).toHaveBeenCalledTimes(2)
  })

  it('carries a server failure into the card instead of asking silently', async () => {
    me.mockRejectedValue(new AuthError(503, 'The server could not sign in right now.'))

    render(
      <AuthGate>
        <p>the ledger</p>
      </AuthGate>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server could not sign in right now.',
    )
  })
})

describe('parseUser', () => {
  it('accepts the shapes a session endpoint plausibly answers with', () => {
    expect(parseUser({ user: { username: 'ada', displayName: 'Ada' } })).toEqual(ADA)
    expect(parseUser({ username: 'grace' })).toEqual({ username: 'grace', displayName: null })
    expect(parseUser({ user: 'noemi' })).toEqual({ username: 'noemi', displayName: null })
  })

  it('reads nobody out of an anonymous or empty answer', () => {
    expect(parseUser({ authenticated: false })).toBeNull()
    expect(parseUser({ user: null })).toBeNull()
    expect(parseUser(null)).toBeNull()
    expect(parseUser('ada')).toBeNull()
  })
})
