/**
 * What core needs from a browser tab. This is the one seam between the library
 * and the outside world: every other module reads time, timers, the network,
 * storage, visibility and reload through it, and tests swap it for a fake with
 * virtual time. It stays out of the public interface.
 */
export interface Environment {
  /** Wall-clock time in ms. The user can change it, so it is only a fallback for server time. */
  wallNow(): number
  /** Time in ms that only moves forward, for measuring intervals. */
  monotonicNow(): number
  /** Run `callback` once after `ms`. Returns a function that cancels it. */
  startTimer(callback: () => void, ms: number): () => void
  fetch: (url: string, init: RequestInit) => Promise<VersionResponse>
  /** Storage shared by the app's tabs. Reading the property or calling it may throw. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  /** The URL that relative URLs resolve against. */
  baseUrl(): string
  isVisible(): boolean
  onVisibilityChange(listener: () => void): () => void
  onFocus(listener: () => void): () => void
  /** Changes other tabs made to `storage`. A cleared storage reports a null key. */
  onStorageChange(listener: (change: StorageChange) => void): () => void
  reload(): void
}

export type VersionResponse = Pick<Response, 'ok' | 'status' | 'json'> & {
  headers: Pick<Headers, 'get'>
}

export interface StorageChange {
  key: string | null
  newValue: string | null
}

function isSharedStorage(area: Storage | null) {
  try {
    return area === localStorage
  } catch {
    return false
  }
}

export function createBrowserEnvironment(): Environment {
  return {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
    startTimer(callback, ms) {
      const id = setTimeout(callback, ms)

      return () => clearTimeout(id)
    },
    fetch: (...args) => fetch(...args),
    get storage() {
      return localStorage
    },
    baseUrl: () => document.baseURI,
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange(listener) {
      document.addEventListener('visibilitychange', listener)

      return () => document.removeEventListener('visibilitychange', listener)
    },
    onFocus(listener) {
      window.addEventListener('focus', listener)

      return () => window.removeEventListener('focus', listener)
    },
    onStorageChange(listener) {
      const onStorage = (event: StorageEvent) => {
        if (isSharedStorage(event.storageArea)) {
          listener({ key: event.key, newValue: event.newValue })
        }
      }

      window.addEventListener('storage', onStorage)

      return () => window.removeEventListener('storage', onStorage)
    },
    reload: () => window.location.reload(),
  }
}
