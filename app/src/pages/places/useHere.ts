/**
 * Where "near me" is.
 *
 * ## Asking is a decision, so it is not made on your behalf
 *
 * The browser's permission prompt is the most jarring thing an app can do unannounced, and a
 * household opening a page about restaurants has not asked to be located. So nothing happens
 * until somebody presses the button: the page opens on the last place they were, or on the
 * city they typed, and offers to use the real thing.
 *
 * ## It always has an answer
 *
 * A location this cannot get is not an error state, it is a different starting point. Refused
 * permission, no GPS, a desktop browser, a tunnel — all of them land on the last known point
 * from `localStorage`, and failing that on nothing at all, which the page renders as "tell us
 * roughly where you are". The commons is not useful only to people who share their position.
 *
 * The last point is kept **rounded to about a kilometre**. It is written to disk, it is the
 * kind of thing that outlives its usefulness, and a neighbourhood is all "near me" ever
 * needed.
 */
import { useCallback, useEffect, useState } from 'react'

import type { Here } from '@/api/commonsHooks'

const STORAGE_KEY = 'twm.here.v1'

/** Two decimal places: about a kilometre, which is the resolution "near me" actually uses. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

function readStored(): Here | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const { lat, lon } = parsed as { lat?: unknown; lon?: unknown }
    if (typeof lat !== 'number' || typeof lon !== 'number') return null
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon }
  } catch {
    // Private mode, quota, a corrupted value. Not knowing where you are is survivable.
    return null
  }
}

function store(here: Here): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ lat: round(here.lat), lon: round(here.lon) }),
    )
  } catch {
    // An optimisation, not state we own.
  }
}

export type HereStatus =
  | 'idle'
  | 'locating'
  | 'ready'
  | 'refused'
  /** The page is not on https or localhost, so the browser will not even ask. */
  | 'insecure'
  /** It asked and nothing came back in time — usually a desktop with no GPS. */
  | 'timeout'
  | 'unavailable'

export interface HereState {
  here: Here | null
  status: HereStatus
  /** Ask the browser. Only ever called from a press. */
  locate: () => void
  /** Somewhere chosen from search, which is the answer for anybody who says no. */
  setHere: (here: Here) => void
}

export function useHere(): HereState {
  const [here, setPoint] = useState<Here | null>(null)
  const [status, setStatus] = useState<HereStatus>('idle')

  useEffect(() => {
    const stored = readStored()
    if (stored !== null) {
      setPoint(stored)
      setStatus('ready')
    }
  }, [])

  const setHere = useCallback((next: Here) => {
    setPoint(next)
    setStatus('ready')
    store(next)
  }, [])

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setStatus('unavailable')
      return
    }

    /*
     * The commonest reason this never works, and the one the old copy could not explain.
     *
     * Geolocation is gated on a secure context. `http://localhost` counts; `http://` on a LAN
     * address does not — so opening the dev server from a phone on the same wifi, which is
     * exactly how somebody would test a page about restaurants, silently fails. Chrome
     * rejects it with POSITION_UNAVAILABLE, indistinguishable from "no GPS", and the page
     * used to answer "your browser could not work out where you are" — true, unhelpful, and
     * not something the person can act on.
     */
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setStatus('insecure')
      return
    }

    setStatus('locating')

    const accept = (position: GeolocationPosition): void => {
      const next = { lat: position.coords.latitude, lon: position.coords.longitude }
      setPoint(next)
      setStatus('ready')
      store(next)
    }

    /*
     * Two attempts, because the first one is cheap and often enough.
     *
     * A coarse fix from wifi or a cell tower usually returns in under a second and is far
     * more accuracy than "what is near me" needs. When that times out — a desktop with no
     * radio to triangulate from, which is where this failed — it is worth one more go with
     * the GPS actually switched on and a minute to find a satellite, rather than reporting
     * failure after eight seconds and making somebody type their own city.
     */
    const onError = (error: GeolocationPositionError): void => {
      if (error.code === error.PERMISSION_DENIED) {
        // Not retried. Offering the same request again after a refusal is nagging.
        setStatus('refused')
        return
      }

      navigator.geolocation.getCurrentPosition(
        accept,
        second => {
          setStatus(second.code === second.TIMEOUT ? 'timeout' : 'unavailable')
        },
        { enableHighAccuracy: true, timeout: 25_000, maximumAge: 5 * 60_000 },
      )
    }

    navigator.geolocation.getCurrentPosition(accept, onError, {
      enableHighAccuracy: false,
      timeout: 8_000,
      maximumAge: 5 * 60_000,
    })
  }, [])

  return { here, status, locate, setHere }
}
