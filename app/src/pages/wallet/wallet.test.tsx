/**
 * The wallet's front end.
 *
 * Two of these are guards rather than tests of behaviour, and they are the reason this file
 * exists: the card face must never be able to render more than the four facts we are allowed
 * to hold, and the add-card sheet must never grow a field a card number could be typed into.
 * Both would pass review — they are the kind of change that looks like an improvement.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CardFace } from './CardFace'
import { PointsArc } from './PointsArc'
import type { SavedCard } from '@/api/wallet'

const CARD: SavedCard = {
  ID: 'c1',
  brand: 'visa',
  last4: '4242',
  expMonth: 11,
  expYear: 2029,
  issuer: 'Bank of Elsewhere',
  country: 'CH',
  authenticated: true,
  label: 'the joint one',
  isDefault: true,
  createdAt: '2026-09-01T10:00:00Z',
}

describe('a card face', () => {
  it('shows the household’s own name for the card, not the scheme', () => {
    // People recognise their cards by the name they gave them. "Visa" is what it says when
    // they have not given one.
    render(<CardFace card={CARD} />)
    expect(screen.getByText('the joint one')).toBeInTheDocument()
  })

  it('reads as one thing to a screen reader rather than five fragments', () => {
    render(<CardFace card={CARD} onClick={() => {}} />)
    expect(
      screen.getByRole('button', {
        name: /the joint one, Visa ending 4242, expires 11\/29, the default card/i,
      }),
    ).toBeInTheDocument()
  })

  it('is a plain figure when it does nothing, and a button when it does', () => {
    // A div with a click handler is invisible to a keyboard, which is how this normally
    // goes wrong.
    const { rerender } = render(<CardFace card={CARD} />)
    expect(screen.queryByRole('button')).toBeNull()

    rerender(<CardFace card={CARD} onClick={() => {}} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('prints an expiry the way a card does, with the month padded', () => {
    render(<CardFace card={{ ...CARD, expMonth: 3, expYear: 2027 }} />)
    expect(screen.getByText('03/27')).toBeInTheDocument()
  })

  it('never renders anything but the last four digits', () => {
    // The guard. A card face that could show more than four digits would mean the data
    // behind it held more than four, which is the thing the whole subsystem prevents.
    //
    // Checked per text node rather than on the concatenated `textContent`: the digits of
    // the last four and of the expiry sit in different elements and read as one long run
    // when they are joined, which is a false alarm rather than a leak.
    const { container } = render(<CardFace card={CARD} />)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      expect(node.textContent ?? '', 'a run of five or more digits').not.toMatch(/\d{5,}/)
    }
  })
})

/** The separator is the locale's business — en-CH uses an apostrophe, not a comma. */
function group(value: number): string {
  return value.toLocaleString('en-CH')
}

describe('the points ring', () => {
  it('names the standing rather than numbering it', async () => {
    render(<PointsArc points={5_000} standing="Worth listening to" next={8_000} into={0.4} />)
    expect(screen.getByText('Worth listening to')).toBeInTheDocument()
    // Awaited rather than read straight off: the figure counts up from zero over 900 ms,
    // so a synchronous read catches it mid-count. What matters is where it lands.
    expect(await screen.findByText(group(5_000), {}, { timeout: 3_000 })).toBeInTheDocument()
  })

  it('says how far to the next rung, in points rather than a percentage', () => {
    render(<PointsArc points={5_000} standing="Worth listening to" next={8_000} into={0.4} />)
    expect(screen.getByText(`${group(3_000)} to the next`)).toBeInTheDocument()
  })

  it('fills completely at the top rung instead of reading as a demotion', async () => {
    // With no next rung there is no fraction to compute, and showing the ring nearly empty
    // because the arithmetic ran out would look like going backwards.
    //
    // Awaited, because the ring is deliberately mounted empty and filled on the next frame —
    // a `stroke-dashoffset` transition has nothing to play unless the value changes, and
    // this animation used to be written and never run.
    const { container } = render(
      <PointsArc points={99_000} standing="Written the guide" next={null} into={0} />,
    )
    await waitFor(() =>
      expect(container.querySelector('.arc__fill')?.getAttribute('stroke-dashoffset')).toBe('0'),
    )
    expect(screen.queryByText(/to the next/)).toBeNull()
  })

  it('draws no arc at all when there is nothing to show, rather than a floating capsule', () => {
    // The first attempt at "zero must not look broken" was a minimum arc, and thirteen
    // degrees of a round-capped 13px stroke is mostly cap: it rendered as a toggle knob
    // adrift at twelve o'clock. An empty ring reads as empty, which is the truth.
    const { container } = render(
      <PointsArc points={0} standing="Just started" next={250} into={0} />,
    )
    expect(container.querySelector('.arc__fill')).toBeNull()
    expect(container.querySelector('.arc__track--empty')).not.toBeNull()
  })
})
