/*
 * The update store — one place that knows whether a newer build is waiting.
 *
 * The service worker is registered in `prompt` mode (vite.config.ts): a new build is
 * downloaded and installed in the background, then *waits* until this store tells it to
 * take over. Between those two moments the store says `ready`, the banner in the shell
 * offers Reload, and the Version card in Settings says the same thing in more words.
 *
 * Nothing here imports `virtual:pwa-register`. `main.tsx` hands the real `registerSW` to
 * `connect()`, and tests hand it a fake — so the store, the banner and the card can be
 * rendered by vitest without the virtual module existing, and the one file that touches
 * the virtual module is the one that already did.
 *
 * Browsers check the worker script on every launch; what they do not do is check while
 * the app stays open on a phone for a week. So the store also asks: once an hour, and
 * whenever the app comes back to the foreground after a while away.
 *
 * Readiness is read off the registration itself, not only off the plugin. The plugin's
 * `onNeedRefresh` reports the build found at launch and the first one found later; but
 * workbox-window stops listening to the registration after that first "external" update,
 * so a second deploy in the same session would never reach it. A phone that stays open
 * for a week sees more than one deploy, and "Later" is a promise about the next build.
 */
import { useSyncExternalStore } from 'react'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

export interface UpdateState {
  /** A service worker registration exists — false in dev and in browsers without one. */
  supported: boolean
  /** A newer build is installed and waiting; `apply()` switches to it. */
  ready: boolean
  /** `check()` is in flight. */
  checking: boolean
  /** A newer build was found and is still downloading — `ready` follows when it is in. */
  installing: boolean
  /** `apply()` was called; the page is about to reload. */
  applying: boolean
  /** ISO timestamp of the last completed `check()`, or null before the first. */
  checkedAt: string | null
  /** The banner was dismissed with "Later"; cleared when a newer build arrives. */
  dismissed: boolean
}

/** The shape of `registerSW` from `virtual:pwa-register`, so a test can pass a fake. */
export type RegisterServiceWorker = (
  options?: RegisterSWOptions,
) => (reloadPage?: boolean) => Promise<void>

/** The slice of `navigator.serviceWorker` the store listens to; a test hands it a fake. */
export type WorkerContainer = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export interface StoreOptions {
  /** Real time, injectable for tests. */
  now?: () => number
  /** What `apply()` falls back to when the worker never takes control. */
  reload?: () => void
  /** Where `controllerchange` fires after `apply()`; null in a browser without workers. */
  container?: WorkerContainer | null
}

/** How often to ask for a new worker while the app stays open. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
/** Coming back to the foreground triggers a check, but not more often than this. */
export const RESUME_THROTTLE_MS = 5 * 60 * 1000
/** `apply()` reloads on its own if the new worker has not taken control by then. */
export const APPLY_FALLBACK_MS = 4000

const INITIAL: UpdateState = {
  supported: false,
  ready: false,
  checking: false,
  installing: false,
  applying: false,
  checkedAt: null,
  dismissed: false,
}

export interface UpdateStore {
  getState: () => UpdateState
  subscribe: (listener: () => void) => () => void
  /** Register the worker and start the periodic checks. Returns the teardown. */
  connect: (register: RegisterServiceWorker) => () => void
  /** Ask the browser for a newer worker script now. Resolves when the check is done. */
  check: () => Promise<void>
  /** Tell the waiting worker to take over; the page reloads when it does. */
  apply: () => Promise<void>
  /** Hide the banner until the next build arrives. */
  dismiss: () => void
  /** Back to the initial state — for tests, which share the singleton. */
  reset: () => void
}

function defaultContainer(): WorkerContainer | null {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : null
}

export function createUpdateStore(options: StoreOptions = {}): UpdateStore {
  const now = options.now ?? (() => Date.now())
  const reload = options.reload ?? (() => window.location.reload())
  const container = options.container === undefined ? defaultContainer() : options.container

  let state: UpdateState = INITIAL
  const listeners = new Set<() => void>()
  let registration: ServiceWorkerRegistration | null = null
  let skipWaiting: ((reloadPage?: boolean) => Promise<void>) | null = null
  /** The waiting worker the banner was shown for, so the same one is not announced twice. */
  let announced: ServiceWorker | null = null
  let lastCheckMs = 0
  let teardown: (() => void) | null = null

  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /** A newer build is installed and waiting: show the banner, even after "Later". */
  const announce = (worker: ServiceWorker | null): void => {
    if (worker !== null && worker === announced) return
    announced = worker
    set({ ready: true, installing: false, dismissed: false })
  }

  /** A worker waiting behind the active one is a newer build, whoever found it. */
  const noticeWaiting = (reg: ServiceWorkerRegistration): void => {
    if (reg.waiting !== null && reg.active !== null) announce(reg.waiting)
  }

  /**
   * `update()` resolves when the *check* is done, not the download — a newer worker found
   * by it is still precaching a couple of megabytes. Show that as "downloading" until the
   * worker reaches `installed`; behind an active worker that means it is now waiting, and
   * the banner goes up. A first install has nothing to wait for and goes straight on to
   * activate, so it is not announced.
   */
  const watchInstalling = (reg: ServiceWorkerRegistration): void => {
    const worker = reg.installing
    // `installing` can be set and already past that state by the time this runs, and a
    // worker that is done installing sends no further `statechange` until it is activated.
    if (worker === null || worker.state !== 'installing') return
    set({ installing: true })
    const onStateChange = (): void => {
      if (worker.state === 'installing') return
      worker.removeEventListener('statechange', onStateChange)
      if (worker.state === 'installed' && reg.waiting === worker && reg.active !== null) {
        announce(worker)
      } else {
        set({ installing: false })
      }
    }
    worker.addEventListener('statechange', onStateChange)
  }

  const check = async (): Promise<void> => {
    if (registration === null || state.checking) return
    set({ checking: true })
    try {
      await registration.update()
      watchInstalling(registration)
      noticeWaiting(registration)
    } catch {
      // Offline, or the worker script is unreachable. Nothing to do until the next check.
    } finally {
      lastCheckMs = now()
      set({ checking: false, checkedAt: new Date(lastCheckMs).toISOString() })
    }
  }

  const connect = (register: RegisterServiceWorker): (() => void) => {
    teardown?.()
    skipWaiting = register({
      immediate: true,
      onNeedRefresh() {
        announce(registration?.waiting ?? null)
      },
      onOfflineReady() {
        console.info('[twm] the ledger is available offline')
      },
      onRegisteredSW(_url, reg) {
        registration = reg ?? null
        set({ supported: registration !== null })
        if (registration === null) return
        // A worker that was already waiting when we registered is reported through
        // `onNeedRefresh` by the plugin; one that is mid-install is not.
        watchInstalling(registration)
        noticeWaiting(registration)
      },
      onRegisterError(error: unknown) {
        console.warn('[twm] the service worker could not be registered', error)
      },
    })

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      if (now() - lastCheckMs < RESUME_THROTTLE_MS) return
      void check()
    }
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    lastCheckMs = now()

    teardown = () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      teardown = null
    }
    return teardown
  }

  const apply = async (): Promise<void> => {
    if (skipWaiting === null || state.applying) return
    set({ applying: true })
    // Reload the moment the new worker takes control. The plugin does the same, but only
    // when a worker was already controlling the page at registration — not in the first
    // session after install. And if control never changes — the waiting worker was already
    // activated by another tab, say — reload anyway: the tap said "give me the new version",
    // and a page that goes quiet is not an answer.
    const fallback = window.setTimeout(reload, APPLY_FALLBACK_MS)
    const onControllerChange = (): void => {
      window.clearTimeout(fallback)
      container?.removeEventListener('controllerchange', onControllerChange)
      reload()
    }
    container?.addEventListener('controllerchange', onControllerChange)
    await skipWaiting(true)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    connect,
    check,
    apply,
    dismiss: () => set({ dismissed: true }),
    reset() {
      teardown?.()
      registration = null
      skipWaiting = null
      announced = null
      lastCheckMs = 0
      set(INITIAL)
    },
  }
}

/** The app's one store. `main.tsx` connects it; the banner and the Version card read it. */
export const updates = createUpdateStore()

export function useAppUpdate(store: UpdateStore = updates): UpdateState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
