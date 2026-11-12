export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface BrowserEnvironment {
  readonly window: EventTarget
  readonly document: EventTarget & {
    readonly visibilityState: DocumentVisibilityState
    readonly baseURI: string
  }
  readonly localStorage: StorageLike
  readonly location: Pick<Location, 'reload'>
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

export function listen(target: EventTarget, type: string, fn: EventListener) {
  target.addEventListener(type, fn)

  return () => target.removeEventListener(type, fn)
}
