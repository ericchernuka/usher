export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface StorageChange {
  readonly key: string | null
  readonly newValue: string | null
  readonly storageArea: StorageLike | null
}

export interface BrowserEnvironment {
  readonly window: EventTarget
  readonly document: EventTarget & {
    readonly visibilityState: DocumentVisibilityState
  }
  readonly localStorage: StorageLike
  readonly location: Pick<Location, 'href' | 'reload'>
  readonly fetch: typeof fetch
}

export function createBrowserEnvironment(): BrowserEnvironment {
  return {
    get window() {
      return window
    },
    get document() {
      return document
    },
    get localStorage() {
      return localStorage
    },
    get location() {
      return window.location
    },
    fetch: (...args) => fetch(...args),
  }
}
