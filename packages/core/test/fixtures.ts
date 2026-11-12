import { test as base, vi } from 'vitest'
import type { AppUpdates, AppUpdatesOptions } from '../src/app-updates'
import type { VersionInfo } from '../src/types'
import { installClock } from './clock'
import { createFakeHost, createStore } from './fake-host'
import { recordRequests } from './requests'

export { describe, expect } from 'vitest'

export const HOUR = 3_600_000
export const MINUTE = 60_000

export const current: VersionInfo = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  builtAt: '2026-11-11T15:00:00.000Z',
}

export const newer: VersionInfo = {
  ...current,
  version: 'bbb',
  commitTime: '2026-11-11T15:30:00.000Z',
}

export const older: VersionInfo = {
  ...current,
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
}

export const SNOOZE_KEY = 'app-version:snooze'

export const test = base
  .extend('clock', { auto: true }, ({}, { onCleanup }) => {
    const clock = installClock()
    onCleanup(() => {
      clock.dispose()
      vi.unstubAllGlobals()
    })

    return clock
  })
  .extend('host', () => createFakeHost())
  .extend('requests', () => recordRequests())
  .extend('app', ({ host, clock }, { onCleanup }) => {
    const stops: Array<() => void> = []
    onCleanup(() => stops.splice(0).forEach(stop => stop()))

    const track = (stop: () => void) => {
      stops.push(stop)

      return stop
    }

    return {
      create: (options: AppUpdatesOptions = {}): AppUpdates =>
        createStore(host, options),
      subscribe: (store: AppUpdates, listener: () => void = () => {}) =>
        track(store.subscribe(listener)),
      track,
      async poll() {
        vi.advanceTimersByTime(MINUTE)
        host.focus()
        await clock.settle()
      },
    }
  })
