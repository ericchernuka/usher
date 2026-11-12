// The store on the real browser globals (no fake host): window and document events,
// localStorage, sessionStorage and location. Everything else is tested in Node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdatesCore } from '../src/core'
import { createAppUpdates } from '../src/index'
import type { VersionInfo } from '../src/types'
import { captureNavigations } from './navigation'

function fail() {
  const event = new Event('vite:preloadError', { cancelable: true })
  window.dispatchEvent(event)

  return event.defaultPrevented
}

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

const SNOOZE_KEY = 'app-version:snooze'
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// No service worker is registered in these runs, so the version endpoint is a narrow fetch stub.
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
  it('given the build baked in by the Vite plugin, when it checks, then it asks /version.json uncached and sees it is up to date', async () => {
    const updates = createAppUpdates({ idleFor: '0s' })
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
    const updates = createAppUpdatesCore({
      current,
      url: '/version.json',
      idleFor: '0s',
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

  it("given a rollback, when another tab dismisses it, then this tab's storage event lowers it too", async () => {
    served = older

    const updates = createAppUpdatesCore({
      current,
      url: '/version.json',
      idleFor: '0s',
    })

    const stop = updates.subscribe(() => {})
    await settle()
    expect(updates.getState().attention).toBe('urgent')

    const snooze = JSON.stringify({
      bad: {
        [current.version]: {
          evidence: ['rollback'],
          until: Date.now() + 30 * 60_000,
        },
      },
    })

    localStorage.setItem(SNOOZE_KEY, snooze)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: SNOOZE_KEY,
        newValue: snooze,
        storageArea: localStorage,
      }),
    )
    expect(updates.getState().attention).toBe('passive')
    stop()
  })

  it('given a lazy chunk fails to load, when it fails again within 10 seconds, then the page reloads once and the second failure is left to the app', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdatesCore({ current, url: '/version.json' })
    const stop = updates.subscribe(() => {})

    expect(fail()).toBe(true)
    expect(navigations).toEqual([{ type: 'reload', url: location.href }])
    expect(fail()).toBe(false)
    expect(navigations).toHaveLength(1)
    expect(sessionStorage.getItem('app-version:chunk-reload')).not.toBeNull()
    stop()
  })
})
