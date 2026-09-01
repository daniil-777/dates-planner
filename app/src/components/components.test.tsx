import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button } from '@ui5/webcomponents-react'
import { AppShell, NAV_ITEMS } from './AppShell'
import { EmptyState } from './EmptyState'
import { EventChip } from './EventChip'
import { MomentBadge } from './MomentBadge'
import { MoneyText } from './MoneyText'
import { PersonPicker } from './PersonPicker'
import { formatAmount, formatMoney, resolveIcon } from '../theme'
import type { Event, Person } from '../api/types'

const PEOPLE: Person[] = [
  { ID: 'p-1', name: 'Ada Lovelace', colour: '#0070F2', isDefault: true },
  { ID: 'p-2', name: 'Grace Hopper', colour: '#F31DED', isDefault: true },
  { ID: 'p-3', name: 'Noemi Berger', colour: '#049F9A', isDefault: false },
  { ID: 'p-4', name: 'Luca Ferrari', colour: '#7858FF', isDefault: false },
  { ID: 'p-5', name: 'Ines Almeida', colour: '#C87200', isDefault: false },
  { ID: 'p-6', name: 'Ravi Patel', colour: '#256F3A', isDefault: false },
]

const LISBON: Event = {
  ID: 'e-1',
  name: 'Lisbon Weekend',
  startsOn: '2026-04-10',
  endsOn: '2026-04-13',
  place: 'Lisboa',
  note: null,
  participants: PEOPLE.slice(0, 4),
}

describe('MoneyText', () => {
  it('renders Swiss money: apostrophe thousands, two decimals, symbol first', () => {
    render(<MoneyText amount={18420.55} />)
    expect(screen.getByTestId('money')).toHaveTextContent("CHF 18'420.55")
  })

  it('groups every third digit, not only the first', () => {
    render(<MoneyText amount={1234567.5} />)
    expect(screen.getByTestId('money')).toHaveTextContent("CHF 1'234'567.50")
  })

  it('keeps the sign in front of the currency, like the statement renderer', () => {
    render(<MoneyText amount={-30.52} />)
    expect(screen.getByTestId('money')).toHaveTextContent('-CHF 30.52')
  })

  it('honours a non-default currency', () => {
    render(<MoneyText amount={12.5} currency="EUR" />)
    expect(screen.getByTestId('money')).toHaveTextContent('EUR 12.50')
  })

  it('never falls back to a locale-grouped comma', () => {
    expect(formatMoney(18420.55)).not.toContain(',')
    expect(formatMoney(0)).toBe('CHF 0.00')
    expect(formatMoney(999.995)).toBe("CHF 1'000.00")
  })

  it('drops the currency for tight cells without stranding the minus sign', () => {
    expect(formatAmount(18420.55)).toBe("18'420.55")
    expect(formatAmount(-30.52)).toBe('-30.52')
  })
})

describe('MomentBadge', () => {
  it('labels a moment code with its display string', () => {
    render(<MomentBadge moment="date_night" />)
    expect(screen.getByText('Date night')).toBeInTheDocument()
  })

  it('covers every moment code in the contract', () => {
    render(
      <>
        <MomentBadge moment="everyday" />
        <MomentBadge moment="trip" />
        <MomentBadge moment="gift" />
      </>,
    )
    expect(screen.getByText('Everyday')).toBeInTheDocument()
    expect(screen.getByText('Trip')).toBeInTheDocument()
    expect(screen.getByText('Gift')).toBeInTheDocument()
  })
})

describe('CategoryChip icons', () => {
  // Four of the ten seeded `Categories.icon` values are not in the SAP-icons collection.
  // If this ever regresses the chip renders an empty box, silently, on every screen.
  const SEEDED = [
    'cart',
    'meal',
    'cup',
    'bus-public-transport',
    'flight',
    'gift',
    'home',
    'heartbeat',
    'video',
    'subscription',
  ]

  it('resolves every seeded category icon to a name the collection actually ships', () => {
    expect(SEEDED.map(name => resolveIcon(name))).toEqual([
      'cart',
      'meal',
      'nutrition-activity',
      'bus-public-transport',
      'flight',
      'present',
      'home',
      'electrocardiogram',
      'video',
      'refresh',
    ])
  })
})

describe('EmptyState', () => {
  it('renders an IllustratedMessage carrying the title, plus the caller action', () => {
    const { container } = render(
      <EmptyState
        icon="receipt"
        title="Nothing posted yet"
        description="Photograph a receipt and it comes back as a draft document."
        action={<Button design="Emphasized">Scan a receipt</Button>}
      />,
    )

    expect(screen.getByTestId('empty-state')).toBeInTheDocument()

    const message = container.querySelector('ui5-illustrated-message')
    expect(message).not.toBeNull()

    const titleText =
      (message as (HTMLElement & { titleText?: string }) | null)?.titleText ??
      message?.getAttribute('title-text')
    expect(titleText).toBe('Nothing posted yet')

    // The action lives in the light DOM, so it is reachable the way a user would reach it.
    expect(screen.getByText('Scan a receipt')).toBeInTheDocument()
  })
})

describe('PersonAvatar', () => {
  it('paints each person in their own colour, with initials from their name', () => {
    render(<PersonPicker people={PEOPLE.slice(0, 2)} selectedIds={[]} onChange={() => {}} />)

    const avatars = screen.getAllByTestId('person-avatar') as Array<
      HTMLElement & { initials?: string }
    >
    expect(avatars).toHaveLength(2)
    expect(avatars[0].initials).toBe('AL')
    expect(avatars[0].style.backgroundColor).toBe('rgb(0, 112, 242)')
    expect(avatars[1].initials).toBe('GH')
    expect(avatars[1].style.backgroundColor).toBe('rgb(243, 29, 237)')
  })
})

describe('PersonPicker', () => {
  it('selects one at a time by default, and clears when the chosen one is clicked again', () => {
    const onChange = vi.fn()
    render(<PersonPicker people={PEOPLE.slice(0, 3)} selectedIds={['p-2']} onChange={onChange} />)

    fireEvent.click(screen.getByText('Ada Lovelace'))
    expect(onChange).toHaveBeenLastCalledWith(['p-1'])

    fireEvent.click(screen.getByText('Grace Hopper'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('adds and removes from the roster when multiple is set', () => {
    const onChange = vi.fn()
    render(
      <PersonPicker
        people={PEOPLE.slice(0, 3)}
        selectedIds={['p-1']}
        multiple
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByText('Noemi Berger'))
    expect(onChange).toHaveBeenLastCalledWith(['p-1', 'p-3'])

    fireEvent.click(screen.getByText('Ada Lovelace'))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.getByText('1 of 3 selected.')).toBeInTheDocument()
  })

  it('grows a filter once the roster is long, and never hides a chosen person', () => {
    render(<PersonPicker people={PEOPLE} selectedIds={['p-6']} onChange={() => {}} />)

    const search = document.querySelector('.twm-people__search') as HTMLElement & { value: string }
    expect(search).not.toBeNull()

    fireEvent.input(search, { target: { value: 'luc' } })
    expect(screen.getByText('Luca Ferrari')).toBeInTheDocument()
    expect(screen.getByText('Ravi Patel')).toBeInTheDocument()
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
  })

  it('says so when there is nobody to pick', () => {
    render(<PersonPicker people={[]} selectedIds={[]} onChange={() => {}} />)
    expect(screen.getByText(/add people in settings/i)).toBeInTheDocument()
  })
})

describe('EventChip', () => {
  it('names the event with its dates and place', () => {
    render(<EventChip event={LISBON} />)
    expect(screen.getByText('Lisbon Weekend')).toBeInTheDocument()
    expect(screen.getByText('10 Apr 2026 – 13 Apr 2026 · Lisboa')).toBeInTheDocument()
  })

  it('shows one date for a single-day event and clears on request', () => {
    const onClear = vi.fn()
    render(
      <EventChip
        event={{ ...LISBON, name: 'Kronenhalle Dinner', endsOn: null, place: 'Zürich' }}
        onClear={onClear}
      />,
    )

    expect(screen.getByText('10 Apr 2026 · Zürich')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove Kronenhalle Dinner'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('AppShell', () => {
  it('mounts the contract destinations and the people from the ledger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ value: PEOPLE }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ledger']}>
          <AppShell>
            <p>page body</p>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(NAV_ITEMS.map(item => item.to)).toEqual([
      '/scan',
      '/ledger',
      '/events',
      '/memories',
      '/calendar',
      '/statement',
      '/settings',
    ])

    // jsdom's matchMedia shim reports no match, so the shell is in its mobile layout:
    // four destinations across the bottom, the last two behind "More".
    for (const label of ['Scan', 'Expenses', 'Events', 'Memories', 'More']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('page body')).toBeInTheDocument()

    await waitFor(() => expect(screen.getAllByTestId('person-avatar').length).toBeGreaterThan(0))
    vi.unstubAllGlobals()
  })

  it('has no side rail: a desktop navigates from the tile grid and the ShellBar', () => {
    // The shim in src/test/setup.ts always reports "no match", which is the mobile layout.
    // Desktop is the layout that used to grow a rail, so this test claims to be one.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ value: PEOPLE }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ledger']}>
          <AppShell>
            <p>page body</p>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(container.querySelector('.twm-sidenav')).toBeNull()
    expect(container.querySelector('ui5-side-navigation')).toBeNull()
    // No navigation region of any kind at this width: the bottom bar is the phone's.
    expect(screen.queryByRole('navigation')).toBeNull()
    // ...and the page it was wrapping is still there, filling the width the rail had.
    expect(screen.getByText('page body')).toBeInTheDocument()

    vi.unstubAllGlobals()
  })
})
