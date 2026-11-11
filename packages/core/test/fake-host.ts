// A stand-in for the browser, so store tests run in Node. Events go through real
// EventTargets; storage is a Map. Only what the store reads exists (see src/host.ts).
import {
  createAppUpdatesCore,
  type AppUpdates,
  type AppUpdatesOptions,
} from '../src/core'
import type { Host, StorageChange, StorageLike } from '../src/host'
import { appVersion } from './build-info.stub'
import { VERSION_URL } from './mocks/handlers'

/** A `storage` event as another tab's write would deliver it. */
class FakeStorageEvent extends Event implements StorageChange {
  readonly key: string | null
  readonly newValue: string | null
  readonly storageArea: StorageLike | null
  constructor(init: {
    key: string | null
    newValue?: string | null
    storageArea: StorageLike | null
  }) {
    super('storage')
    this.key = init.key
    this.newValue = init.newValue ?? null
    this.storageArea = init.storageArea
  }
}

export class MemoryStorage implements StorageLike {
  readonly #items = new Map<string, string>()
  getItem(key: string) {
    return this.#items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.#items.set(key, value)
  }
  removeItem(key: string) {
    this.#items.delete(key)
  }
  clear() {
    this.#items.clear()
  }
}

/** A navigation the page tried to make: `assign` is a push, `reload` a reload. */
export interface Navigation {
  type: 'push' | 'reload'
  url: string
}

export function createFakeHost(options: { fetch?: typeof fetch } = {}) {
  const navigations: Navigation[] = []
  const localStorage = new MemoryStorage()
  const sessionStorage = new MemoryStorage()
  const windowTarget = new EventTarget()
  const documentTarget = new EventTarget()

  const visibility: { visibilityState: DocumentVisibilityState } = {
    visibilityState: 'visible',
  }
  const doc = Object.assign(documentTarget, visibility)

  const location = {
    href: 'https://app.test/now',
    reload: () => void navigations.push({ type: 'reload', url: location.href }),
    assign: (url: string | URL) =>
      void navigations.push({
        type: 'push',
        url: new URL(url, location.href).href,
      }),
  }

  const host: Host = {
    window: windowTarget,
    document: doc,
    localStorage,
    sessionStorage,
    location,
    fetch: options.fetch ?? ((...args) => fetch(...args)), // MSW answers these
  }

  return {
    host,
    localStorage,
    sessionStorage,
    location,
    navigations,
    focus: () => windowTarget.dispatchEvent(new Event('focus')),
    keydown: () => windowTarget.dispatchEvent(new Event('keydown')),
    /** Change visibility and tell the page, as the browser does. */
    setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state
      documentTarget.dispatchEvent(new Event('visibilitychange'))
    },
    /** Change visibility without the event (a tab that was hidden before the store started). */
    setVisibilitySilently(state: DocumentVisibilityState) {
      doc.visibilityState = state
    },
    /** What this tab sees when another tab writes `localStorage[key]` (or `clear()`s, with a null key). */
    storageEvent(key: string | null, newValue: string | null = null) {
      windowTarget.dispatchEvent(
        new FakeStorageEvent({ key, newValue, storageArea: localStorage }),
      )
    },
    /** Another tab sets the key: storage changes first, then the event arrives. */
    otherTabSets(key: string, value: string) {
      localStorage.setItem(key, value)
      windowTarget.dispatchEvent(
        new FakeStorageEvent({
          key,
          newValue: value,
          storageArea: localStorage,
        }),
      )
    },
    /** Another tab removes the key. */
    otherTabRemoves(key: string) {
      localStorage.removeItem(key)
      windowTarget.dispatchEvent(
        new FakeStorageEvent({
          key,
          newValue: null,
          storageArea: localStorage,
        }),
      )
    },
    /** `vite:preloadError`, returning whether the app's handler claimed it. */
    preloadError() {
      const event = new Event('vite:preloadError', { cancelable: true })
      windowTarget.dispatchEvent(event)

      return event.defaultPrevented
    },
    /** `window.dispatchEvent` with an arbitrary event, e.g. a storage event for another area. */
    dispatch: (event: Event) => windowTarget.dispatchEvent(event),
    storageEventFor(key: string | null, area: StorageLike | null) {
      windowTarget.dispatchEvent(
        new FakeStorageEvent({ key, storageArea: area }),
      )
    },
  }
}

export type FakeHost = ReturnType<typeof createFakeHost>

export const stubBuild = appVersion

/** The store under test, on the fake host and the MSW-served version URL. */
export function createStore(
  fake: FakeHost,
  options: AppUpdatesOptions = {},
): AppUpdates {
  return createAppUpdatesCore({
    current: stubBuild,
    url: VERSION_URL,
    host: fake.host,
    ...options,
  })
}
