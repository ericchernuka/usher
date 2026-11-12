import { test as base, vi } from 'vitest'
import { createAppUpdatesStore, type AppUpdates } from '../src/app-updates'
import type { AppUpdatesOptions, BuildFacts } from '../src/types'
import { runningBuild } from './build-info.stub'
import { createFakeEnvironment, type FakeEnvironment } from './fake-environment'
import { serverClock, VERSION_URL } from './mocks/handlers'
import { recordRequests } from './requests'

export { describe, expect } from 'vitest'

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE

export const running: BuildFacts = runningBuild

export const newer: BuildFacts = {
  ...running,
  version: 'bbb',
  commitTime: '2026-11-11T15:30:00.000Z',
}

export const older: BuildFacts = {
  ...running,
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
}

export const DISMISSAL_KEY = 'app-version:prompt-dismissal'

export type StoreOptions = Partial<Omit<AppUpdatesOptions, 'running'>>

export function createStore(
  tab: FakeEnvironment,
  options: StoreOptions = {},
): AppUpdates {
  return createAppUpdatesStore(
    { running, versionUrl: VERSION_URL, ...options },
    tab.env,
  )
}

export const test = base
  .extend('tab', ({}, { onCleanup }) => {
    const tab = createFakeEnvironment()
    serverClock.now = tab.now
    onCleanup(() => {
      serverClock.now = Date.now
      vi.restoreAllMocks()
    })

    return tab
  })
  .extend('requests', () => recordRequests())
  .extend('app', ({ tab }, { onCleanup }) => {
    const stops: Array<() => void> = []
    onCleanup(() => stops.splice(0).forEach(stop => stop()))

    const track = (stop: () => void) => {
      stops.push(stop)

      return stop
    }

    return {
      create: (options: StoreOptions = {}): AppUpdates =>
        createStore(tab, options),
      subscribe: (store: AppUpdates, listener: () => void = () => {}) =>
        track(store.subscribe(listener)),
      track,
      /** A minute later the tab regains focus, which triggers a check. */
      async poll() {
        await tab.runFor(MINUTE)
        tab.focus()
        await tab.waitForResponse()
      },
    }
  })
