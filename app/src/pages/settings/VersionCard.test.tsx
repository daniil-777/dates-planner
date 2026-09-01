/*
 * The Version card: both stamps on the table, and the right next step.
 *
 * `useHealth` is mocked so the server's stamp can be anything; the update store is a fresh
 * one per test with a fake registration, so "asks the worker to look" is observable as a
 * call on `registration.update()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import type { Health } from '@/api/types'
import { formatDateTime } from '@/theme'
import { BUILD } from '@/update/build'
import { createUpdateStore, type UpdateStore } from '@/update/store'

interface HealthShape {
  data: Health | undefined
  isPending: boolean
  isError: boolean
}

const health: HealthShape = { data: undefined, isPending: true, isError: false }

vi.mock('@/api/hooks', () => ({ useHealth: () => health }))

import { VersionCard, describeBuild } from './VersionCard'

let store: UpdateStore
let options: RegisterSWOptions | undefined
const update = vi.fn(async () => {})
const registration = {
  update,
  installing: null,
  waiting: null,
  active: {},
} as unknown as ServiceWorkerRegistration

function serverBuild(build: Health['build']): void {
  health.data = { status: 'ok', docai: 'mock', llm: 'template', version: '1.0.0', build }
  health.isPending = false
  health.isError = false
}

beforeEach(() => {
  update.mockClear()
  health.data = undefined
  health.isPending = true
  health.isError = false
  store = createUpdateStore({ reload: () => {} })
  store.connect(o => {
    options = o
    return async () => {}
  })
  options?.onRegisteredSW?.('/sw.js', registration)
})

afterEach(() => {
  store.reset()
})

describe('VersionCard', () => {
  it('names the build this device is running', () => {
    render(<VersionCard store={store} production />)
    expect(screen.getByText(describeBuild(BUILD))).toBeInTheDocument()
    expect(
      screen.getByText(`v${BUILD.version} · ${BUILD.commit}`, { exact: false }),
    ).toBeInTheDocument()
  })

  it('is up to date when the server has the same build', () => {
    serverBuild({ ...BUILD })
    render(<VersionCard store={store} production />)
    expect(screen.getByText('up to date')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it('says the server is ahead and asks the worker to look — once', async () => {
    serverBuild({ ...BUILD, commit: 'deadbee' })
    const { rerender } = render(<VersionCard store={store} production />)
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    // The check found nothing new (the fake registration installs nothing), so the card is
    // back to saying what the mismatch means — and does not ask again on the next render.
    expect(await screen.findByText(/the server has a newer build/)).toBeInTheDocument()

    rerender(<VersionCard store={store} production />)
    await waitFor(() => expect(store.getState().checking).toBe(false))
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('does not compare in development, where the server serves a different bundle', () => {
    serverBuild({ ...BUILD, commit: 'deadbee' })
    render(<VersionCard store={store} production={false} />)
    expect(screen.getByText('up to date')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it('offers Reload now once the new build is installed', async () => {
    serverBuild({ ...BUILD, commit: 'deadbee' })
    render(<VersionCard store={store} production />)
    act(() => options?.onNeedRefresh?.())
    expect(await screen.findByText(/a new version is ready/)).toBeInTheDocument()
    // UI5 buttons are custom elements, which jsdom does not expose as `role=button`.
    expect(screen.getByText('Reload now')).toBeInTheDocument()
  })

  it('says so when the server is not answering — on both lines', () => {
    health.isPending = false
    health.isError = true
    render(<VersionCard store={store} production />)
    expect(screen.getByText(/server not answering/)).toBeInTheDocument()
    // Not "not reported": that would mean the server answered and had no stamp.
    expect(screen.getByText('not answering')).toBeInTheDocument()
    expect(screen.queryByText('not reported')).not.toBeInTheDocument()
  })

  it('checks on request', async () => {
    serverBuild({ ...BUILD })
    render(<VersionCard store={store} production />)
    fireEvent.click(screen.getByText('Check for updates'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/checked \d{2}:\d{2}/)).toBeInTheDocument()
  })
})

describe('describeBuild', () => {
  it('leaves the date off a build that has none', () => {
    expect(describeBuild({ version: '0.0.0', commit: 'unknown', builtAt: '' })).toBe(
      'v0.0.0 · unknown',
    )
    // The date is rendered in the machine's own zone, so it is asserted through the same
    // formatter rather than as a calendar day that UTC-11 and UTC+14 would disagree on.
    const stamped = { version: '1.2.0', commit: '8cea17b', builtAt: '2026-09-01T10:47:13.211Z' }
    expect(describeBuild(stamped)).toBe(`v1.2.0 · 8cea17b · ${formatDateTime(stamped.builtAt)}`)
    expect(formatDateTime(stamped.builtAt)).toMatch(/^\d{1,2} \w{3} 2026, \d{2}:\d{2}$/)
  })
})
