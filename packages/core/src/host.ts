// Internal. Everything the store reads from the browser, in one place, so tests can hand it a
// fake and run in Node. `browserHost()` reads the globals lazily, so importing this module
// (or creating a store) on a server touches nothing.

/** The slice of `Storage` the store uses. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** The fields of a `storage` event the store reads. */
export interface StorageChange {
  readonly key: string | null
  readonly newValue: string | null
  readonly storageArea: StorageLike | null
}

export interface Host {
  /** Receives `focus` and `storage`. */
  readonly window: EventTarget
  /** Receives `visibilitychange`. */
  readonly document: EventTarget & {
    readonly visibilityState: DocumentVisibilityState
  }
  /** Shared between tabs; may throw when blocked. */
  readonly localStorage: StorageLike
  readonly location: Pick<Location, 'href' | 'reload'>
  /** Fetches `version.json`. */
  readonly fetch: typeof fetch
}

/** The real browser. Each property reads its global on access, never earlier. */
export function browserHost(): Host {
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
    fetch: (...args) => fetch(...args), // looked up per call, so stubs and interceptors apply
  }
}
