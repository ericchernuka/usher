import { test as base, vi } from 'vitest'
import type { AppUpdates } from '../src/app-updates'
import type { BuildFacts } from '../src/types'
import { installClock } from './clock'
import { createFakeHost, createStore, type StoreOptions } from './fake-host'
import { recordRequests } from './requests'

export { describe, expect } from 'vitest'

export const HOUR = 3_600_000
export const MINUTE = 60_000

export const running: BuildFacts = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  buildTime: '2026-11-11T15:00:00.000Z',
}

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

export const test = base
  .extend('clock', { auto: true }, ({}, { onCleanup }) => {
    const clock = installClock()
    onCleanup(() => {
      clock.dispose()
      vi.unstubAllGlobals()
    })

    return clock
  })
  .extend('host', ({ clock }) => createFakeHost({ fetch: clock.fetch }))
  .extend('requests', () => recordRequests())
  .extend('app', ({ host, clock }, { onCleanup }) => {
    const stops: Array<() => void> = []
    onCleanup(() => stops.splice(0).forEach(stop => stop()))

    const track = (stop: () => void) => {
      stops.push(stop)

      return stop
    }

    return {
      create: (options: StoreOptions = {}): AppUpdates =>
        createStore(host, options),
      subscribe: (store: AppUpdates, listener: () => void = () => {}) =>
        track(store.subscribe(listener)),
      track,
      async poll() {
        vi.advanceTimersByTime(MINUTE)
        host.focus()
        await clock.waitForResponse()
      },
    }
  })
