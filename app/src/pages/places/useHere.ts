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

export type HereStatus = 'idle' | 'locating' | 'ready' | 'refused' | 'unavailable'

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
    setStatus('locating')
    navigator.geolocation.getCurrentPosition(
      position => {
        const next = { lat: position.coords.latitude, lon: position.coords.longitude }
        setPoint(next)
        setStatus('ready')
        store(next)
      },
      error => {
        // Told apart on purpose: "you said no" and "it did not work" want different words,
        // and offering to try again after a refusal is nagging.
        setStatus(error.code === error.PERMISSION_DENIED ? 'refused' : 'unavailable')
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 5 * 60_000 },
    )
  }, [])

  return { here, status, locate, setHere }
}
