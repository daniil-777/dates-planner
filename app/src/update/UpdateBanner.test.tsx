/*
 * The banner: invisible until a build is waiting, one primary action, one way to say later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SHOWN_CLASS, UpdateBanner } from './UpdateBanner'
import { createUpdateStore, type UpdateStore } from './store'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

let store: UpdateStore
let options: RegisterSWOptions | undefined
const skipWaiting = vi.fn(async () => {})
const reload = vi.fn()

beforeEach(() => {
  skipWaiting.mockClear()
  reload.mockClear()
  store = createUpdateStore({ reload })
  store.connect(o => {
    options = o
    return skipWaiting
  })
})

afterEach(() => {
  store.reset()
})

describe('UpdateBanner', () => {
  it('renders nothing while there is nothing to reload into', () => {
    render(<UpdateBanner store={store} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers Reload once a build is waiting, and applies on tap', async () => {
    render(<UpdateBanner store={store} />)
    act(() => options?.onNeedRefresh?.())

    expect(screen.getByRole('status')).toHaveTextContent('A new version is ready.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    })
    expect(skipWaiting).toHaveBeenCalledWith(true)
    expect(screen.getByRole('button', { name: 'Reloading…' })).toBeDisabled()
  })

  it('goes away on Later and comes back with the next build', () => {
    render(<UpdateBanner store={store} />)
    act(() => options?.onNeedRefresh?.())
    expect(screen.getByRole('status')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => options?.onNeedRefresh?.())
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('reserves room at the bottom of the page only while it is up', () => {
    const html = document.documentElement
    const { unmount } = render(<UpdateBanner store={store} />)
    expect(html.classList.contains(SHOWN_CLASS)).toBe(false)

    act(() => options?.onNeedRefresh?.())
    expect(html.classList.contains(SHOWN_CLASS)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(html.classList.contains(SHOWN_CLASS)).toBe(false)

    act(() => options?.onNeedRefresh?.())
    expect(html.classList.contains(SHOWN_CLASS)).toBe(true)
    unmount()
    expect(html.classList.contains(SHOWN_CLASS)).toBe(false)
  })
})
