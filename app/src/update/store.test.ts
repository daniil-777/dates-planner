/*
 * The update store, driven through a fake `registerSW`.
 *
 * What it must get right: `ready` comes from the plugin's `onNeedRefresh` *or* from a worker
 * the store's own check watched into the waiting state — the plugin stops reporting after
 * the first update it did not find itself; a tap on Reload tells the waiting worker to take
 * over, reloads the moment it does, and reloads on its own if that never happens; the
 * periodic and on-resume checks ask the registration, throttled; and "Later" hides the
 * banner only until the next build — including one the plugin never mentions.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import {
  APPLY_FALLBACK_MS,
  CHECK_INTERVAL_MS,
  RESUME_THROTTLE_MS,
  createUpdateStore,
  type RegisterServiceWorker,
  type UpdateStore,
} from './store'

interface FakeWorker {
  state: ServiceWorkerState
  listeners: Set<() => void>
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
  transition: (state: ServiceWorkerState) => void
}

function fakeWorker(): FakeWorker {
  const listeners = new Set<() => void>()
  return {
    state: 'installing',
    listeners,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    transition(state) {
      this.state = state
      for (const listener of [...listeners]) listener()
    },
  }
}

type SkipWaiting = (reloadPage?: boolean) => Promise<void>

interface FakeRegistration {
  update: Mock<() => Promise<void>>
  installing: FakeWorker | null
  waiting: FakeWorker | null
  /** Any object stands for the worker currently in charge; null means a first install. */
  active: object | null
}

interface Harness {
  store: UpdateStore
  options: () => RegisterSWOptions
  skipWaiting: Mock<SkipWaiting>
  registration: FakeRegistration
  /** Stands in for `navigator.serviceWorker`: `controllerchange` is dispatched on it. */
  container: EventTarget
  reload: Mock<() => void>
  clock: { now: number }
  /** Register, and report a registration back, the way the plugin does. */
  connect: () => void
}

function harness(): Harness {
  let captured: RegisterSWOptions | undefined
  const skipWaiting = vi.fn<SkipWaiting>(async () => {})
  const register: RegisterServiceWorker = options => {
    captured = options
    return skipWaiting
  }
  const registration: FakeRegistration = {
    update: vi.fn<() => Promise<void>>(async () => {}),
    installing: null,
    waiting: null,
    active: {},
  }
  const container = new EventTarget()
  const reload = vi.fn<() => void>()
  const clock = { now: 1_000_000 }
  const store = createUpdateStore({ now: () => clock.now, reload, container })
  return {
    store,
    options: () => {
      if (captured === undefined) throw new Error('registerSW was not called')
      return captured
    },
    skipWaiting,
    registration,
    container,
    reload,
    clock,
    connect() {
      store.connect(register)
      this.options().onRegisteredSW?.(
        '/sw.js',
        registration as unknown as ServiceWorkerRegistration,
      )
    },
  }
}

/**
 * The next `check()` finds a new build: a worker appears as `installing` and, once its
 * precache is in, becomes the registration's `waiting` worker — the way a browser does it.
 */
function nextCheckFinds(h: Harness): FakeWorker {
  const worker = fakeWorker()
  h.registration.update.mockImplementationOnce(async () => {
    h.registration.installing = worker
  })
  const finish = worker.transition.bind(worker)
  worker.transition = state => {
    if (state === 'installed') {
      h.registration.installing = null
      h.registration.waiting = worker
    }
    finish(state)
  }
  return worker
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

beforeEach(() => {
  vi.useFakeTimers()
  setVisibility('visible')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('update store — registration', () => {
  it('registers immediately and reports a registration as supported', () => {
    const h = harness()
    expect(h.store.getState().supported).toBe(false)
    h.connect()
    expect(h.options().immediate).toBe(true)
    expect(h.store.getState().supported).toBe(true)
  })

  it('stays unsupported when the plugin reports no registration', () => {
    const h = harness()
    let captured: RegisterSWOptions | undefined
    h.store.connect(options => {
      captured = options
      return h.skipWaiting
    })
    captured?.onRegisteredSW?.('/sw.js', undefined)
    expect(h.store.getState().supported).toBe(false)
  })

  it('becomes ready when the plugin says a new build is waiting', () => {
    const h = harness()
    h.connect()
    h.options().onNeedRefresh?.()
    expect(h.store.getState()).toMatchObject({ ready: true, installing: false, dismissed: false })
  })

  it('notifies subscribers on every change', () => {
    const h = harness()
    const listener = vi.fn()
    h.store.subscribe(listener)
    h.connect()
    h.options().onNeedRefresh?.()
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('update store — applying', () => {
  it('tells the waiting worker to take over and reloads on its own if it never does', async () => {
    const h = harness()
    h.connect()
    h.options().onNeedRefresh?.()

    await h.store.apply()
    expect(h.skipWaiting).toHaveBeenCalledWith(true)
    expect(h.store.getState().applying).toBe(true)
    expect(h.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(APPLY_FALLBACK_MS)
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads the moment the new worker takes control, and only once', async () => {
    const h = harness()
    h.connect()
    h.options().onNeedRefresh?.()
    await h.store.apply()

    h.container.dispatchEvent(new Event('controllerchange'))
    expect(h.reload).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(APPLY_FALLBACK_MS)
    h.container.dispatchEvent(new Event('controllerchange'))
    expect(h.reload).toHaveBeenCalledTimes(1)
  })

  it('applies once, however many times Reload is tapped', async () => {
    const h = harness()
    h.connect()
    h.options().onNeedRefresh?.()
    await h.store.apply()
    await h.store.apply()
    expect(h.skipWaiting).toHaveBeenCalledTimes(1)
  })

  it('does nothing before anything is registered', async () => {
    const h = harness()
    await h.store.apply()
    expect(h.skipWaiting).not.toHaveBeenCalled()
    expect(h.store.getState().applying).toBe(false)
  })
})

describe('update store — checking', () => {
  it('asks the registration and records when', async () => {
    const h = harness()
    h.connect()
    h.clock.now = 2_000_000
    const pending = h.store.check()
    expect(h.store.getState().checking).toBe(true)
    await pending
    expect(h.registration.update).toHaveBeenCalledTimes(1)
    expect(h.store.getState()).toMatchObject({
      checking: false,
      checkedAt: new Date(2_000_000).toISOString(),
    })
  })

  it('survives a failed check — offline is not an error state', async () => {
    const h = harness()
    h.connect()
    h.registration.update.mockRejectedValueOnce(new Error('offline'))
    await h.store.check()
    expect(h.store.getState().checking).toBe(false)
    expect(h.store.getState().checkedAt).not.toBeNull()
  })

  it('is a no-op without a registration', async () => {
    const h = harness()
    await h.store.check()
    expect(h.store.getState().checkedAt).toBeNull()
  })

  it('reports a found build as downloading, then ready once it is installed and waiting', async () => {
    const h = harness()
    h.connect()
    const worker = nextCheckFinds(h)
    await h.store.check()
    expect(h.store.getState()).toMatchObject({ installing: true, ready: false })

    worker.transition('installed')
    expect(h.store.getState()).toMatchObject({ installing: false, ready: true, dismissed: false })
    expect(worker.listeners.size).toBe(0)
  })

  it('does not announce a first install — there is nothing for it to wait behind', async () => {
    const h = harness()
    h.registration.active = null
    h.connect()
    const worker = nextCheckFinds(h)
    await h.store.check()
    worker.transition('installed')
    expect(h.store.getState()).toMatchObject({ installing: false, ready: false })
  })

  it('does not announce a build that failed to install', async () => {
    const h = harness()
    h.connect()
    const worker = nextCheckFinds(h)
    await h.store.check()
    worker.transition('redundant')
    expect(h.store.getState()).toMatchObject({ installing: false, ready: false })
  })

  it('notices a worker that was already waiting when it registered', () => {
    const h = harness()
    h.registration.waiting = fakeWorker()
    h.connect()
    expect(h.store.getState().ready).toBe(true)
  })

  it('does not call a worker that has already finished installing "downloading"', async () => {
    const h = harness()
    h.connect()
    const worker = fakeWorker()
    worker.state = 'installed'
    h.registration.update.mockImplementationOnce(async () => {
      h.registration.installing = worker
    })
    await h.store.check()
    expect(h.store.getState().installing).toBe(false)
    expect(worker.listeners.size).toBe(0)
  })

  it('checks once an hour while the app stays open', () => {
    const h = harness()
    h.connect()
    vi.advanceTimersByTime(CHECK_INTERVAL_MS - 1)
    expect(h.registration.update).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.registration.update).toHaveBeenCalledTimes(1)
  })

  it('checks when the app comes back to the foreground, throttled', () => {
    const h = harness()
    h.connect()

    // Straight after launch the browser has just checked; coming back at once is not a reason.
    document.dispatchEvent(new Event('visibilitychange'))
    expect(h.registration.update).not.toHaveBeenCalled()

    h.clock.now += RESUME_THROTTLE_MS
    document.dispatchEvent(new Event('visibilitychange'))
    expect(h.registration.update).toHaveBeenCalledTimes(1)

    // Going to the background is not coming back.
    h.clock.now += RESUME_THROTTLE_MS
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(h.registration.update).toHaveBeenCalledTimes(1)
  })

  it('stops checking after reset', () => {
    const h = harness()
    h.connect()
    h.store.reset()
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 3)
    h.clock.now += CHECK_INTERVAL_MS * 3
    document.dispatchEvent(new Event('visibilitychange'))
    expect(h.registration.update).not.toHaveBeenCalled()
    expect(h.store.getState().supported).toBe(false)
  })
})

describe('update store — dismissing', () => {
  it('hides the banner until the next build arrives', () => {
    const h = harness()
    h.connect()
    h.options().onNeedRefresh?.()
    h.store.dismiss()
    expect(h.store.getState()).toMatchObject({ ready: true, dismissed: true })

    h.options().onNeedRefresh?.()
    expect(h.store.getState().dismissed).toBe(false)
  })

  it('brings the banner back for a build the plugin never reports', async () => {
    // The plugin reports the first update found after launch and then stops listening to
    // the registration; the second deploy of the week only shows up as a worker the
    // store's own check watches into `waiting`.
    const h = harness()
    h.connect()
    h.options().onNeedRefresh?.()
    h.store.dismiss()

    const worker = nextCheckFinds(h)
    await h.store.check()
    worker.transition('installed')
    expect(h.store.getState()).toMatchObject({ ready: true, dismissed: false })
  })

  it('does not nag about the same waiting worker on every hourly check', async () => {
    const h = harness()
    h.connect()
    const worker = nextCheckFinds(h)
    await h.store.check()
    worker.transition('installed')
    h.store.dismiss()

    await h.store.check()
    expect(h.registration.waiting).toBe(worker)
    expect(h.store.getState()).toMatchObject({ ready: true, dismissed: true })
  })
})
