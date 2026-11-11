import { useDeferredValue, useEffect, useSyncExternalStore } from 'react'
import type { AppUpdates, ReloadBlocker, UpdateState } from '@app-version/core'

const identity = <T>(state: T) => state
let warnedUnstableSelector = false

/**
 * Read update state, Zustand / TanStack Store style: pass the store and an optional
 * selector. Re-renders only when the selected value changes (Object.is), so the
 * selector must return a stable value: a field, not a new object.
 *
 * The value is deferred (useSyncExternalStore + useDeferredValue, the pattern the
 * React team recommends for concurrent-friendly external stores): a store change
 * renders at transition priority, never blocks input, and keeps current UI instead
 * of showing a Suspense fallback. See README "Decisions".
 *
 *   const attention = useAppUpdates(appUpdates, (s) => s.attention);
 */
export function useAppUpdates(store: AppUpdates): UpdateState
export function useAppUpdates<T>(
  store: AppUpdates,
  selector: (state: UpdateState) => T,
): T
export function useAppUpdates<T>(
  store: AppUpdates,
  selector: (state: UpdateState) => T = identity as never,
): T {
  const snapshot = () => {
    const state = store.getState()
    const value = selector(state)

    // Dev-only footgun check: a selector that builds a new object loops useSyncExternalStore.
    if (
      import.meta.env?.DEV &&
      !warnedUnstableSelector &&
      !Object.is(value, selector(state))
    ) {
      warnedUnstableSelector = true
      console.error(
        '[app-version] useAppUpdates selector returned a different value for the same state. ' +
          'Return a field (s => s.attention), not a new object or array.',
      )
    }

    return value
  }

  const value = useSyncExternalStore(store.subscribe, snapshot, snapshot)

  return useDeferredValue(value)
}

/**
 * Block reloads while this component needs it, like React Router's useBlocker.
 * Pass a boolean, or a function of the reload details.
 *
 *   useReloadBlocker(appUpdates, form.isDirty);
 */
export function useReloadBlocker(
  store: AppUpdates,
  shouldBlock: boolean | ReloadBlocker,
): void {
  useEffect(() => {
    if (shouldBlock === false) {
      return
    }
    return store.addReloadBlocker(
      typeof shouldBlock === 'function' ? shouldBlock : () => true,
    )
  }, [store, shouldBlock])
}
