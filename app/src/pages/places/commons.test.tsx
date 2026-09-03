/**
 * The commons, on screen.
 *
 * Most of what matters about this feature is a *refusal*, so most of these tests check that
 * something is absent. Three of them would be a privacy incident if they failed, and one
 * would be a lie about a restaurant:
 *
 *  - **A place below the threshold shows no rating at all.** Not zero stars, not five empty
 *    outlines — both read as "everybody hated it", which is the opposite of true for
 *    somewhere nobody has judged. This is the single easiest thing to get wrong here, because
 *    the obvious `stars ?? 0` is one character and looks harmless.
 *  - **Nothing on screen describes who rated a place.** No filter, no label, no chip. ADR-002
 *    §6 refuses to store a household's shape and this is where it would come back.
 *  - **The map links carry no key and no identifier**, because Google and Apple are
 *    destinations rather than stores.
 *  - **The cost is per person**, never per couple — nothing in this app may assume a
 *    household is two people.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { Evening, PlaceCard } from '@/api/commons'
import { EveningCardView } from '@/pages/tonight/EveningCard'
import { PlaceCardView } from './PlaceCard'
import { StarRating } from './Stars'
import { TagChips } from './Chips'
import {
  ANONYMITY_THRESHOLD,
  COST_BANDS,
  PLACE_TAGS,
  TAG_LABEL,
  costLabel,
  distanceLabel,
  householdsLabel,
} from './vocabulary'

function place(overrides: Partial<PlaceCard> = {}): PlaceCard {
  return {
    ID: 'p1',
    name: 'Kafi Dihei',
    kind: 'cafe',
    lat: 47.3769,
    lon: 8.5417,
    city: 'Zürich',
    distance: 420,
    stars: 4.4,
    households: 12,
    published: true,
    needs: 0,
    costBand: 'c15_30',
    tags: ['quiet', 'walk_after'],
    googleUrl: 'https://www.google.com/maps/search/?api=1&query=47.376900%2C8.541700',
    appleUrl: 'https://maps.apple.com/?ll=47.376900%2C8.541700&q=Kafi%20Dihei',
    ...overrides,
  }
}

function draw(node: React.ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('a place nobody has rated enough', () => {
  it('shows no rating at all, rather than a bad one', () => {
    draw(
      <PlaceCardView
        place={place({
          published: false,
          stars: null,
          households: 1,
          needs: 2,
          tags: [],
          costBand: null,
        })}
      />,
    )

    // The whole point: not "0.0", not five empty stars, not "—". Nothing.
    expect(screen.queryByText('0.0')).toBeNull()
    expect(screen.queryByText(/^0/)).toBeNull()
    expect(document.querySelector('.stars')).toBeNull()
  })

  it('says how many more households are needed, so the silence is explained', () => {
    draw(
      <PlaceCardView place={place({ published: false, stars: null, households: 1, needs: 2 })} />,
    )
    expect(screen.getByText(/1 household so far/)).toBeInTheDocument()
    expect(screen.getByText(/2 more/)).toBeInTheDocument()
  })

  it('draws nothing when the rating is null, whatever the count says', () => {
    const { container } = draw(<StarRating value={null} households={9} />)
    expect(container.textContent).toBe('')
  })
})

describe('a published place', () => {
  it('shows the mean and the denominator together', () => {
    draw(<PlaceCardView place={place()} />)
    expect(screen.getByText('4.4')).toBeInTheDocument()
    // A rating without its denominator is a number pretending to be a fact.
    expect(screen.getByText(householdsLabel(12))).toBeInTheDocument()
  })

  it('offers both map apps, with no key or identifier in either link', () => {
    draw(<PlaceCardView place={place()} />)
    const google = screen.getByRole('link', { name: 'Google Maps' })
    const apple = screen.getByRole('link', { name: 'Apple Maps' })

    for (const link of [google, apple]) {
      const href = link.getAttribute('href') ?? ''
      expect(href).not.toMatch(/key=|apikey|token|session/i)
      // Opening a map must not hand the destination our referrer either.
      expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    }
    expect(google.getAttribute('href')).toContain('google.com/maps')
    expect(apple.getAttribute('href')).toContain('maps.apple.com')
  })

  it('says the cost per person, never per couple', () => {
    draw(<PlaceCardView place={place()} />)
    expect(screen.getByText(/CHF 15–30/)).toBeInTheDocument()
    // "for two" would be wrong for most households that will ever read it.
    expect(document.body.textContent).not.toMatch(/for two|per couple|each person pays/i)
  })
})

describe('an evening card', () => {
  const evening: Evening = {
    ID: 'seed:p1',
    eat: place(),
    doPlace: null,
    doIdea: {
      ID: 'i1',
      title: 'Walk the whole tram line',
      summary: 'Ride one line to the end you have never seen.',
      costBand: 'free',
      minutes: 150,
    },
    costBand: 'c15_30',
    because: 'quiet enough to talk — 12 households',
  }

  it('is a whole evening: somewhere to eat, then something to do', () => {
    draw(<EveningCardView evening={evening} index={0} onPlan={() => {}} />)
    expect(screen.getByText('Kafi Dihei')).toBeInTheDocument()
    expect(screen.getByText('Walk the whole tram line')).toBeInTheDocument()
    // The order is part of the suggestion.
    expect(screen.getByText('then')).toBeInTheDocument()
  })

  it('leads with what the pair costs one person', () => {
    draw(<EveningCardView evening={evening} index={0} onPlan={() => {}} />)
    expect(screen.getByText(costLabel('c15_30'))).toBeInTheDocument()
    expect(costLabel('c15_30')).toContain('each')
  })

  it('names the corpus and never a rank', () => {
    draw(<EveningCardView evening={evening} index={0} onPlan={() => {}} />)
    expect(screen.getByText(/12 households/)).toBeInTheDocument()
    // A league table invites "is this the best?" instead of "would we like this?".
    expect(document.body.textContent).not.toMatch(/#\d|\bno\.\s*\d|top \d|best in/i)
  })

  it('hands the evening to the events page rather than growing a second one', () => {
    const onPlan = vi.fn()
    draw(<EveningCardView evening={evening} index={0} onPlan={onPlan} />)
    screen.getByRole('button', { name: 'Plan it' }).click()
    expect(onPlan).toHaveBeenCalled()
  })
})

describe('the vocabulary on screen', () => {
  it('has a label for every code, and none of them describes the people', () => {
    for (const tag of PLACE_TAGS) {
      expect(TAG_LABEL[tag], `${tag} has no label`).toBeTruthy()
      // ADR-002 §6 / ADR-003 §5: the commons must not reintroduce group composition, and a
      // label is exactly where it would arrive first — the code could stay innocent.
      expect(TAG_LABEL[tag]).not.toMatch(
        /couple|gay|straight|lesbian|\bmen\b|\bwomen\b|gender|orientation/i,
      )
    }
  })

  it('says "each" on every cost band that names a number', () => {
    for (const band of COST_BANDS) {
      if (band === 'free') continue
      expect(costLabel(band), `${band} does not say who is paying`).toMatch(/each$/)
    }
  })

  it('reads a distance the way somebody standing in the street would', () => {
    expect(distanceLabel(420)).toBe('420 m')
    expect(distanceLabel(1243)).toBe('1.2 km')
    expect(distanceLabel(null)).toBeNull()
  })

  it('counts households in words, with a singular that is not "1 households"', () => {
    expect(householdsLabel(1)).toBe('1 household')
    expect(householdsLabel(ANONYMITY_THRESHOLD)).toBe('3 households')
  })
})

describe('chips', () => {
  it('shows a few and counts the rest rather than wrapping to four rows', () => {
    draw(<TagChips tags={['quiet', 'view', 'walk_after', 'great_food', 'late_open']} limit={3} />)
    const list = screen.getByRole('list')
    expect(within(list).getByText('+2')).toBeInTheDocument()
    expect(within(list).queryByText(TAG_LABEL.late_open)).toBeNull()
  })

  it('draws nothing at all when a place has none', () => {
    const { container } = draw(<TagChips tags={[]} />)
    expect(container.textContent).toBe('')
  })
})
