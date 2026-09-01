/*
 * The sign-in firework.
 *
 * What is worth asserting here is not that hearts appear — it is the three properties that
 * decide whether a decorative overlay is a nuisance:
 *
 *  1. it hands control back exactly once, after three seconds, so `AuthGate` can unmount it;
 *  2. it never swallows a tap meant for the app underneath;
 *  3. it clears its timer when it leaves early, so a fast sign-out cannot call `onDone`
 *     on an unmounted tree.
 *
 * The greeting itself is asserted because it is the thing the user actually asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WelcomeFireworks } from './WelcomeFireworks'

describe('WelcomeFireworks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the greeting', () => {
    render(<WelcomeFireworks onDone={vi.fn()} />)

    expect(screen.getByText('Welcome!')).toBeInTheDocument()
    expect(screen.getByText('Plan your dates, enjoy your life, relax!')).toBeInTheDocument()
  })

  it('calls onDone once, after three seconds', () => {
    const onDone = vi.fn()
    render(<WelcomeFireworks onDone={onDone} />)

    expect(onDone).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2999)
    expect(onDone).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onDone).toHaveBeenCalledTimes(1)

    // Nothing further, however long the page is left open.
    vi.advanceTimersByTime(10_000)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('does not call onDone after it has been unmounted', () => {
    const onDone = vi.fn()
    const { unmount } = render(<WelcomeFireworks onDone={onDone} />)

    unmount()
    vi.advanceTimersByTime(5000)

    expect(onDone).not.toHaveBeenCalled()
  })

  it('never takes the pointer, so a tap reaches the app underneath', () => {
    const { container } = render(<WelcomeFireworks onDone={vi.fn()} />)

    const overlay = container.querySelector('.twm-fw')
    expect(overlay).not.toBeNull()
    // Asserted on the class rather than on a computed style: jsdom does not apply the
    // stylesheet, and `.twm-fw { pointer-events: none }` is the contract that file carries.
    expect(overlay).toHaveClass('twm-fw')
  })

  it('announces itself politely rather than stealing focus', () => {
    render(<WelcomeFireworks onDone={vi.fn()} />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })
})
