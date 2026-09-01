/**
 * First-launch state.
 *
 * One flag in `localStorage`, `twm.onboarded`, decides whether the wizard takes over the
 * screen. It is deliberately not a server field: the ledger is shared across the
 * household's devices, and each device gets its own introduction the first time it is
 * opened.
 *
 * Every access is wrapped, because `localStorage` throws rather than returning null in a
 * Safari private window, and a storage exception must never be the reason the app is blank.
 */

export const ONBOARDED_KEY = 'twm.onboarded'

/** True when this browser has been through the wizard (or explicitly skipped it). */
export function isOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) !== null
  } catch {
    // No storage means no memory of an introduction, but showing the wizard on every load
    // would be worse than showing it never. Treat it as done.
    return true
  }
}

/** Records that the introduction happened, with the timestamp for the curious. */
export function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, new Date().toISOString())
  } catch {
    /* nothing to do: the wizard simply appears again next time */
  }
}

/** Forgets it, so Settings can offer to replay the introduction. */
export function clearOnboarded(): void {
  try {
    window.localStorage.removeItem(ONBOARDED_KEY)
  } catch {
    /* see above */
  }
}

/** When the introduction was completed, or null. */
export function onboardedAt(): string | null {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY)
  } catch {
    return null
  }
}
