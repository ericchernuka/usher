import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdates } from '../src/index'
import type { BuildFacts } from '../src/build-facts'
import { captureNavigations } from './navigation'

const running: BuildFacts = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  buildTime: '2026-11-11T15:00:00.000Z',
}

const older: BuildFacts = {
  ...running,
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

let served: BuildFacts

beforeEach(() => {
  served = running
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
    const updates = createAppUpdates({ running, versionUrl: '/version.json' })
    const stop = updates.state.subscribe(() => {})
    await settle()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^http.+\/version\.json\?t=\d+$/),
      expect.objectContaining({ cache: 'no-store' }),
    )
    expect(updates.state.get().attention).toBe('none')
    stop()
  })

  it('given a tab that stays open, when it regains focus after a minute, then it checks again and finds the new build', async () => {
    const updates = createAppUpdates({
      running,
      versionUrl: '/version.json',
    })

    const stop = updates.state.subscribe(() => {})
    await settle()
    served = older
    vi.advanceTimersByTime(61_000)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(updates.state.get()).toMatchObject({
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
          ...running,
          version: 'new',
          commitTime: '2026-11-12T00:00:00Z',
        }),
      ),
    )

    const updates = createAppUpdates({
      running,
      versionUrl: '/version.json',
    })

    const stop = updates.state.subscribe(() => {})
    await vi.waitFor(() => expect(updates.state.get().attention).toBe('prompt'))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'usher:prompt-dismissal',
        newValue: JSON.stringify({ dismissedAt: Date.now() }),
        storageArea: localStorage,
      }),
    )
    expect(updates.state.get().attention).toBe('passive')
    stop()
  })

  it('given sessionStorage is cleared, then a localStorage dismissal is not undone', async () => {
    vi.setSystemTime(new Date('2026-11-12T04:00:00Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          ...running,
          version: 'new',
          commitTime: '2026-11-12T00:00:00Z',
        }),
      ),
    )
    const updates = createAppUpdates({ running, versionUrl: '/version.json' })
    const stop = updates.state.subscribe(() => {})
    await vi.waitFor(() => expect(updates.state.get().attention).toBe('prompt'))
    expect(updates.state.dismiss()).toBe(true)

    window.dispatchEvent(
      new StorageEvent('storage', { key: null, storageArea: sessionStorage }),
    )

    expect(updates.state.get().attention).toBe('passive')
    stop()
  })

  it('given a chunk error, then the library does not prevent it or reload', async () => {
    const navigations = captureNavigations()

    const updates = createAppUpdates({
      running,
      versionUrl: '/version.json',
    })

    const stop = updates.state.subscribe(() => {})
    const event = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    await settle()
    expect(event.defaultPrevented).toBe(false)
    expect(navigations).toEqual([])
    stop()
  })
})
