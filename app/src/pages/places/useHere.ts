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
 * ## Getting the position *right*, which took three goes
 *
 * An earlier version of this file put a household in the wrong place, and it did it three
 * different ways at once. All three are worth naming, because each one looks like a
 * reasonable optimisation on its own:
 *
 *  1. **It asked for a coarse fix first.** `enableHighAccuracy: false` returns in well under
 *     a second, which is lovely, and on a laptop it is derived from wifi or the IP address —
 *     routinely kilometres out, sometimes the middle of the ISP's nearest city. The retry
 *     with the GPS on only ran when the coarse attempt *failed*, and it almost never fails.
 *     The fast answer was the wrong answer, and it won.
 *  2. **It accepted a five-minute-old cached fix.** `maximumAge` is how you get a position
 *     from before somebody got on a tram.
 *  3. **It restored a rounded point as though it were live.** The stored point is deliberately
 *     rounded to about a kilometre — that part is right, it is written to disk and a
 *     neighbourhood is all "near me" ever needed. But it came back as `ready`, so the map
 *     opened centred up to 800 m from where somebody was standing, with nothing saying so.
 *
 * So: always high accuracy, never a cached fix, and a restored point is flagged
 * {@link approximate} so the map can offer a real one rather than quietly pretending.
 *
 * ## Why it keeps watching for a moment
 *
 * The first GPS fix is usually the worst one — a phone reports something within a few hundred
 * metres, then tightens to ten as more satellites come in. `watchPosition` for a short window
 * takes those improvements and stops as soon as the fix is good enough, which is both more
 * accurate than one `getCurrentPosition` and faster than waiting for the best one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Here } from '@/api/commonsHooks'

const STORAGE_KEY = 'twm.here.v1'

/** Good enough to stop watching: a street, not a building. */
const GOOD_ENOUGH_M = 40

/** How long to keep refining before settling for the best fix so far. */
const REFINE_MS = 12_000

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
  /**
   * Metres of uncertainty around {@link here}, when the browser told us.
   *
   * Exposed rather than kept private because the map draws it. A dot with no circle is a
   * claim of precision the browser never made, and on a laptop the honest circle is the size
   * of a district — which explains, without a word of copy, why the dot is not where somebody
   * is standing.
   */
  accuracy: number | null
  /** True when the point came from storage or from a search, rather than from a live fix. */
  approximate: boolean
  /** Ask the browser. Only ever called from a press. */
  locate: () => void
  /** Somewhere chosen from search, which is the answer for anybody who says no. */
  setHere: (here: Here) => void
}

export function useHere(): HereState {
  const [here, setPoint] = useState<Here | null>(null)
  const [status, setStatus] = useState<HereStatus>('idle')
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [approximate, setApproximate] = useState(true)
  const watch = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopWatching = useCallback(() => {
    if (watch.current !== null) {
      navigator.geolocation.clearWatch(watch.current)
      watch.current = null
    }
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => {
    const stored = readStored()
    if (stored !== null) {
      setPoint(stored)
      setStatus('ready')
      // Rounded to ~1 km when it was written, and of unknown age. The map shows it so the
      // page is usable at once, and says it is approximate so nobody reads it as a fix.
      setApproximate(true)
      setAccuracy(1_100)
    }
    return stopWatching
  }, [stopWatching])

  const setHere = useCallback((next: Here) => {
    setPoint(next)
    setStatus('ready')
    setApproximate(true)
    setAccuracy(null)
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

    stopWatching()
    setStatus('locating')

    let best = Number.POSITIVE_INFINITY

    const accept = (position: GeolocationPosition): void => {
      const metres = position.coords.accuracy
      // Only ever move the dot closer to the truth. A later, vaguer reading — which happens
      // when a phone drops from GPS back to wifi — must not undo a good one.
      if (Number.isFinite(metres) && metres >= best) return
      best = Number.isFinite(metres) ? metres : best

      const next = { lat: position.coords.latitude, lon: position.coords.longitude }
      setPoint(next)
      setAccuracy(Number.isFinite(metres) ? Math.round(metres) : null)
      setApproximate(false)
      setStatus('ready')
      store(next)

      if (Number.isFinite(metres) && metres <= GOOD_ENOUGH_M) stopWatching()
    }

    const fail = (error: GeolocationPositionError): void => {
      stopWatching()
      if (error.code === error.PERMISSION_DENIED) {
        // Not retried. Offering the same request again after a refusal is nagging.
        setStatus('refused')
        return
      }
      // A fix that already arrived is kept: losing the satellite after a good reading is not
      // a reason to throw the reading away.
      setStatus(
        best === Number.POSITIVE_INFINITY
          ? error.code === error.TIMEOUT
            ? 'timeout'
            : 'unavailable'
          : 'ready',
      )
    }

    watch.current = navigator.geolocation.watchPosition(accept, fail, {
      // All three matter, and all three were wrong before. High accuracy so the fix comes
      // from GPS rather than from an IP address; no cached position, so it is where somebody
      // is now rather than where they were; and long enough that a cold GPS can answer.
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 30_000,
    })

    // Stop refining eventually even if the fix never gets tight — indoors it may never reach
    // 40 m, and a watch left running is a radio left on.
    timer.current = setTimeout(stopWatching, REFINE_MS)
  }, [stopWatching])

  return { here, status, accuracy, approximate, locate, setHere }
}
