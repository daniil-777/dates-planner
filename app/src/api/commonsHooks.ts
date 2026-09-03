/**
 * TanStack Query bindings for the commons — FRONTEND-CONTRACT §10.
 *
 * Separate from `hooks.ts` for the same reason `commons.ts` is separate from `client.ts`: the
 * two services have opposite rules, and a query key that could be either is a cache that
 * could serve one household another's data. Every key here begins with `'commons'`, so an
 * invalidation of the ledger can never reach the corpus and the reverse cannot happen either.
 *
 * Two things about the caching are deliberate:
 *
 * - **`tonight` is cached for the day.** The server deals from a seed of the date and the
 *   household, so asking twice gives the same three cards; caching it here means a person
 *   flicking between tabs does not even ask. It is refetched when the tab has been away long
 *   enough that the day may have turned over, and never on window focus, because a card deck
 *   that reshuffles while you are deciding is a card deck nobody can choose from.
 * - **Rating invalidates broadly.** One rating can move a place into view for the first time
 *   (it may be the third), change its position in every list, and change what `tonight`
 *   deals. Invalidating the whole `'commons'` tree is one refetch of a small payload and is
 *   much easier to reason about than enumerating what moved.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { commons } from './commons'
import type { Evening, IdeaCard, NearbyQuery, PlaceCard, PlaceDetail, RatingInput } from './commons'
import type { CostBand } from '@/pages/places/vocabulary'

/** Where the person is, once they have said. Null means they have not, or refused. */
export interface Here {
  lat: number
  lon: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function useNearby(here: Here | null, query: Omit<NearbyQuery, 'lat' | 'lon'> = {}) {
  return useQuery({
    queryKey: ['commons', 'nearby', here?.lat, here?.lon, query.kind, query.tag, query.radiusM],
    queryFn: () => commons.nearby({ ...query, lat: here!.lat, lon: here!.lon }),
    enabled: here !== null,
    staleTime: 60_000,
  })
}

export function usePlaceDetail(id: string | null) {
  return useQuery({
    queryKey: ['commons', 'place', id],
    queryFn: () => commons.placeDetail(id!),
    enabled: id !== null,
  })
}

export function useTonight(here: Here | null, maxCost: CostBand | null = null) {
  return useQuery({
    queryKey: ['commons', 'tonight', here?.lat, here?.lon, maxCost],
    queryFn: () => commons.tonight(here!.lat, here!.lon, maxCost),
    enabled: here !== null,
    // The deal is stable for the day, so there is nothing to gain by asking again — and a
    // deck that reshuffles mid-decision is worse than a stale one.
    staleTime: DAY_MS,
    refetchOnWindowFocus: false,
  })
}

export function useDeck(name: 'activity' | 'gift') {
  return useQuery({
    queryKey: ['commons', 'deck', name],
    queryFn: () => commons.deck(name),
    // Seeded cards; they change when a deploy changes them.
    staleTime: DAY_MS,
  })
}

/** Debounced by the caller — this hook only asks when there is enough to ask about. */
export function usePlaceSearch(query: string, here: Here | null) {
  return useQuery({
    queryKey: ['commons', 'search', query, here?.lat, here?.lon],
    queryFn: () => commons.search(query, here?.lat ?? null, here?.lon ?? null),
    enabled: query.trim().length >= 3,
    staleTime: 10 * 60_000,
  })
}

function useInvalidateCommons(): () => Promise<void> {
  const client = useQueryClient()
  return async () => {
    await client.invalidateQueries({ queryKey: ['commons'] })
  }
}

export function useRate() {
  const invalidate = useInvalidateCommons()
  return useMutation<PlaceCard, Error, RatingInput>({
    mutationFn: (input: RatingInput) => commons.rate(input),
    onSuccess: invalidate,
  })
}

export function useWithdrawRating() {
  const invalidate = useInvalidateCommons()
  return useMutation<PlaceCard, Error, string>({
    mutationFn: (placeID: string) => commons.withdrawRating(placeID),
    onSuccess: invalidate,
  })
}

export function useReportTip() {
  const invalidate = useInvalidateCommons()
  return useMutation<boolean, Error, { placeID: string; reason: string }>({
    mutationFn: ({ placeID, reason }) => commons.reportTip(placeID, reason),
    onSuccess: invalidate,
  })
}

export type { Evening, IdeaCard, PlaceCard, PlaceDetail }
