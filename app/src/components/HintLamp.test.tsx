/**
 * The hint lamp.
 *
 * Most of these guard the rule that makes the pattern worth having rather than the pattern
 * itself: the hints are reachable, they are announced, and the glow that makes the lamp
 * noticeable happens once and never again.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HintLamp } from './HintLamp'

const HINTS = ['Only you can change your own.', 'Partial is fine — most people stop early.']

/**
 * The real one, kept so the test that breaks storage can put it back.
 *
 * Without this, replacing `window.localStorage` with a throwing stub leaks into every test
 * that runs afterwards — including this file's own `beforeEach`, which calls `clear()`. It
 * happens to be the last test today, which is exactly the kind of accident that survives
 * until somebody reorders something.
 */
const REAL_STORAGE = window.localStorage

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  Object.defineProperty(window, 'localStorage', { value: REAL_STORAGE, configurable: true })
})

describe('the lamp', () => {
  it('starts closed, with its hints out of the accessibility tree', () => {
    render(<HintLamp id="test" hints={HINTS} />)
    const button = screen.getByRole('button', { name: /hints/i })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(HINTS[0]!)).not.toBeVisible()
  })

  it('opens on press and shows every hint', () => {
    render(<HintLamp id="test" hints={HINTS} />)

    fireEvent.click(screen.getByRole('button', { name: /hints/i }))
    expect(screen.getByRole('button', { name: /hints/i })).toHaveAttribute('aria-expanded', 'true')
    for (const hint of HINTS) expect(screen.getByText(hint)).toBeVisible()
  })

  it('is operable from a keyboard', () => {
    // A help affordance that needs a pointer excludes exactly the people most likely to want
    // the help. A real <button> gets Enter and Space for free from the browser, so what has
    // to be true is that it IS one, that it is focusable, and that it carries no handler the
    // keyboard cannot reach.
    render(<HintLamp id="test" hints={HINTS} />)
    const button = screen.getByRole('button', { name: /hints/i })

    expect(button.tagName).toBe('BUTTON')
    expect(button).not.toHaveAttribute('disabled')
    expect(button.getAttribute('tabindex')).not.toBe('-1')

    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(screen.getByText(HINTS[0]!)).toBeVisible()
  })

  it('points the button at the panel it opens', async () => {
    // `aria-controls` plus DOM order is what puts the hints one Tab away from the control
    // that revealed them, rather than somewhere a screen reader has to hunt for.
    render(<HintLamp id="test" hints={HINTS} />)
    const controls = screen.getByRole('button', { name: /hints/i }).getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls!)).not.toBeNull()
  })

  it('glows once on a screen nobody has seen, and never again', async () => {
    // The commonest failure of this pattern is an affordance nobody notices, which becomes
    // decoration and then a dumping ground. The second-commonest is one that nags.
    const { unmount } = render(<HintLamp id="between-us" hints={HINTS} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hints/i }).className).toContain('--glow'),
    )

    fireEvent.click(screen.getByRole('button', { name: /hints/i }))
    expect(screen.getByRole('button', { name: /hints/i }).className).not.toContain('--glow')
    unmount()

    render(<HintLamp id="between-us" hints={HINTS} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hints/i }).className).not.toContain('--glow'),
    )
  })

  it('remembers per screen, so a second lamp still introduces itself', async () => {
    const { unmount } = render(<HintLamp id="between-us" hints={HINTS} />)
    fireEvent.click(screen.getByRole('button', { name: /hints/i }))
    unmount()

    render(<HintLamp id="mood" hints={HINTS} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hints/i }).className).toContain('--glow'),
    )
  })

  it('still renders when storage refuses', async () => {
    // A private window, or a full quota. Glowing again is a small cost; losing the lamp over
    // it would not be.
    const broken = {
      getItem: () => {
        throw new Error('nope')
      },
      setItem: () => {
        throw new Error('nope')
      },
    }
    Object.defineProperty(window, 'localStorage', { value: broken, configurable: true })

    render(<HintLamp id="test" hints={HINTS} />)
    fireEvent.click(screen.getByRole('button', { name: /hints/i }))
    expect(screen.getByText(HINTS[0]!)).toBeVisible()
  })
})
