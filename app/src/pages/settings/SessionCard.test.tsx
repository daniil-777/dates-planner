/*
 * Signing out.
 *
 * The card is small, but two of its behaviours are worth pinning because getting either
 * wrong leaves somebody signed in when they believe they are not:
 *
 *  1. a successful sign-out navigates, rather than re-rendering in place — the session
 *     cookie is httpOnly and the react-query cache is full of the household's postings, and
 *     only a full navigation drops both;
 *  2. a *failed* sign-out does not navigate, and says so. Navigating anyway would show the
 *     login screen while the server-side session was still perfectly valid — the worst of
 *     the three possible outcomes, because it looks like success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const logout = vi.fn()
const me = vi.fn()

vi.mock('@/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@/api/auth')>('@/api/auth')
  return { ...actual, logout: () => logout(), me: () => me() }
})

import { SessionCard } from './SessionCard'

const assign = vi.fn()

beforeEach(() => {
  logout.mockReset().mockResolvedValue(undefined)
  me.mockReset().mockResolvedValue({ username: 'daniil@example.com', displayName: 'Daniil' })
  assign.mockReset()
  // jsdom's location is not assignable; replace the whole object for this suite.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SessionCard', () => {
  it('names who is signed in', async () => {
    render(<SessionCard />)
    expect(await screen.findByText(/Signed in as Daniil/)).toBeInTheDocument()
  })

  it('falls back to the login when the server has no display name', async () => {
    me.mockResolvedValue({ username: 'someone@example.com', displayName: null })
    render(<SessionCard />)
    expect(await screen.findByText(/Signed in as someone@example.com/)).toBeInTheDocument()
  })

  it('still renders a way out when /api/auth/me cannot be reached', async () => {
    me.mockRejectedValue(new Error('offline'))
    render(<SessionCard />)

    expect(await screen.findByText(/This browser has a session/)).toBeInTheDocument()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })

  it('signs out and navigates away', async () => {
    render(<SessionCard />)
    fireEvent.click(screen.getByText('Sign out'))

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
  })

  it('does not navigate when signing out failed, and says why', async () => {
    logout.mockRejectedValue(new Error('network down'))
    render(<SessionCard />)

    fireEvent.click(screen.getByText('Sign out'))

    expect(await screen.findByText(/Could not reach the server to sign out/)).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
    // And the button comes back, rather than being left disabled forever.
    await waitFor(() => expect(screen.getByText('Sign out')).toBeInTheDocument())
  })
})
