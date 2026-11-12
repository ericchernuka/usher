import {
  createAppUpdatesCore,
  type AppUpdates,
  type AppUpdatesOptions,
} from '../src/core'
import type { Host, StorageChange, StorageLike } from '../src/host'
import { appVersion } from './build-info.stub'
import { VERSION_URL } from './mocks/handlers'

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

class MemoryStorage implements StorageLike {
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

interface MutableVisibility {
  visibilityState: DocumentVisibilityState
}

export function createFakeHost(options: { fetch?: typeof fetch } = {}) {
  const navigations: Array<{ type: 'reload'; url: string }> = []

  const localStorage: StorageLike & Pick<Storage, 'removeItem' | 'clear'> =
    new MemoryStorage()

  const sessionStorage: StorageLike & Pick<Storage, 'removeItem' | 'clear'> =
    new MemoryStorage()

  const windowTarget = new EventTarget()
  const documentTarget = new EventTarget()

  const visibility: MutableVisibility = {
    visibilityState: 'visible',
  }

  const doc = Object.assign(documentTarget, visibility)

  const location = {
    href: 'https://app.test/now',
    reload: () => void navigations.push({ type: 'reload', url: location.href }),
  }

  const host: Host = {
    window: windowTarget,
    document: doc,
    localStorage,
    location,
    fetch: options.fetch ?? ((...args) => fetch(...args)),
  }

  return {
    host,
    localStorage,
    sessionStorage,
    location,
    navigations,
    focus: () => windowTarget.dispatchEvent(new Event('focus')),
    keydown: () => windowTarget.dispatchEvent(new Event('keydown')),
    setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state
      documentTarget.dispatchEvent(new Event('visibilitychange'))
    },
    setVisibilitySilently(state: DocumentVisibilityState) {
      doc.visibilityState = state
    },
    storageEvent(key: string | null, newValue: string | null = null) {
      windowTarget.dispatchEvent(
        new FakeStorageEvent({ key, newValue, storageArea: localStorage }),
      )
    },
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
    preloadError() {
      const event = new Event('vite:preloadError', { cancelable: true })
      windowTarget.dispatchEvent(event)

      return event.defaultPrevented
    },
    dispatch: (event: Event) => windowTarget.dispatchEvent(event),
    storageEventFor(key: string | null, area: StorageLike | null) {
      windowTarget.dispatchEvent(
        new FakeStorageEvent({ key, storageArea: area }),
      )
    },
  }
}

export type FakeHost = ReturnType<typeof createFakeHost>

const stubBuild = appVersion

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
