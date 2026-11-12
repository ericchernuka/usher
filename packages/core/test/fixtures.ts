// Fixtures for store tests, in Playwright's `test.extend` style. A test lists the fixtures it
// needs in its context argument (`app`, `clock`, `host`, `requests`) and gets fresh,
// isolated copies that are torn down afterwards.
import { test as base, vi } from 'vitest'
import type { AppUpdates, AppUpdatesOptions } from '../src/core'
import type { VersionInfo } from '../src/types'
import { installClock } from './clock'
import { createFakeHost, createStore } from './fake-host'
import { recordRequests } from './requests'

export { describe, expect } from 'vitest'

export const HOUR = 3_600_000
export const MINUTE = 60_000

/** The build the tab runs (the stub in `build-info.stub.ts`). */
export const current: VersionInfo = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  builtAt: '2026-11-11T15:00:00.000Z',
}

/** A deploy after ours. */
export const newer: VersionInfo = {
  ...current,
  version: 'bbb',
  commitTime: '2026-11-11T15:30:00.000Z',
}

/** A rollback: an older commit than the one the tab runs. */
export const older: VersionInfo = {
  ...current,
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
}

/** The snooze record other tabs share through localStorage. */
export const SNOOZE_KEY = 'app-version:snooze'

export const test = base
  // Auto: fake time is always installed, before the host and stores that read it.
  // oxlint-disable-next-line no-empty-pattern -- vitest requires a destructured first argument; this fixture has no dependencies
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
      /** An update store on the fake host. */
      create: (options: AppUpdatesOptions = {}): AppUpdates =>
        createStore(host, options),
      /** Subscribe for the rest of the test (or until the returned stop). */
      subscribe: (store: AppUpdates, listener: () => void = () => {}) =>
        track(store.subscribe(listener)),
      /** Register cleanup for something else the test started, e.g. `connectPrompt`. */
      track,
      /** A minute passes and the tab regains focus: the next check goes out and lands. */
      async poll() {
        vi.advanceTimersByTime(MINUTE)
        host.focus()
        await clock.settle()
      },
    }
  })
