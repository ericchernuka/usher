import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdatesStore } from '../src/app-updates'
import { createAppUpdates } from '../src/index'
import type { VersionInfo } from '../src/types'
import { captureNavigations } from './navigation'

const current: VersionInfo = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  builtAt: '2026-11-11T15:00:00.000Z',
}

const older: VersionInfo = {
  ...current,
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

let served: VersionInfo

beforeEach(() => {
  served = current
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date('2026-11-11T16:00:00Z'))
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(served)),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the store on the real browser', () => {
  it('given explicit build facts and a version URL, then it checks uncached and sees it is up to date', async () => {
    const updates = createAppUpdates({ current, url: '/version.json' })
    const stop = updates.subscribe(() => {})
    await settle()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/version\.json\?t=\d+$/),
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(updates.getState().attention).toBe('none')
    stop()
  })

  it('given a tab that stays open, when it regains focus after a minute, then it checks again and finds the new build', async () => {
    const updates = createAppUpdatesStore({
      current,
      url: '/version.json',
    })

    const stop = updates.subscribe(() => {})
    await settle()
    served = older
    vi.advanceTimersByTime(61_000)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(updates.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
    stop()
  })

  it('given a stale build, then a localStorage event dismisses its prompt', async () => {
    vi.setSystemTime(new Date('2026-11-12T04:00:00Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          ...current,
          version: 'new',
          commitTime: '2026-11-12T00:00:00Z',
        }),
      ),
    )
    const updates = createAppUpdatesStore({ current, url: '/version.json' })
    const stop = updates.subscribe(() => {})
    await vi.waitFor(() => expect(updates.getState().attention).toBe('prompt'))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'app-version:snooze',
        newValue: JSON.stringify({ promptAt: Date.now() }),
        storageArea: localStorage,
      }),
    )
    expect(updates.getState().attention).toBe('passive')
    stop()
  })

  it('given a chunk error, then the library does not prevent it or reload', () => {
    const navigations = captureNavigations()
    const updates = createAppUpdatesStore({ current, url: '/version.json' })
    const stop = updates.subscribe(() => {})
    const event = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(navigations).toEqual([])
    stop()
  })
})
