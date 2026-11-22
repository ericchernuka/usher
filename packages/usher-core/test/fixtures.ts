import { test as base, vi } from 'vitest'
import { createAppUpdates, type AppUpdates } from '../src/index'
import { createTabIn } from '../src/tab'
import type { BuildFacts } from '../src/build-facts'
import type { AppUpdatesOptions } from '../src/types'
import { runningBuild } from './build-info.stub'
import {
  createFakeEnvironment,
  type FakeEnvironment,
} from '../src/fake-environment'
import { serverClock, VERSION_URL } from './mocks/handlers'
import { recordRequests } from './requests'

export { describe, expect } from 'vitest'

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

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

export const DISMISSAL_KEY = 'usher:prompt-dismissal'

export type StoreOptions = Partial<Omit<AppUpdatesOptions, 'running'>>

export function createStore(
  tab: FakeEnvironment,
  options: StoreOptions = {},
): AppUpdates {
  return createAppUpdates(
    { running, versionUrl: VERSION_URL, ...options },
    createTabIn(tab.env),
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
        track(store.state.subscribe(listener)),
      track,
      async poll() {
        await tab.runFor(MINUTE)
        tab.focus()
        await tab.waitForResponse()
      },
    }
  })
