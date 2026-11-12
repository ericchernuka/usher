import {
  useDeferredValue,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type {
  AppUpdates,
  RefreshBlocker,
  UpdateState,
} from '@rndsqr/usher-core'

/**
 * Read the update state. Snapshots keep their identity until something changes,
 * which happens a handful of times in a tab's life, so read a field directly:
 *
 *   const { attention } = useUpdateState(appUpdates)
 *
 * The value is deferred. A store change renders at transition priority, so it
 * never blocks input and never swaps visible UI for a Suspense fallback.
 */
export function useUpdateState(updates: AppUpdates): UpdateState {
  const state = useSyncExternalStore(
    updates.subscribe,
    updates.getState,
    updates.getState,
  )

  return useDeferredValue(state)
}

/**
 * Block refreshes while this component needs it, like React Router's useBlocker.
 * Pass a boolean, or a function that returns one when a refresh is requested.
 * The function may be written inline: the blocker is registered once and always
 * calls the one from the latest render.
 *
 *   useRefreshBlocker(appUpdates, form.isDirty)
 */
export function useRefreshBlocker(
  updates: AppUpdates,
  shouldBlock: boolean | RefreshBlocker,
): void {
  const latest = useRef(shouldBlock)

  useEffect(() => {
    latest.current = shouldBlock
  }, [shouldBlock])

  const registered = shouldBlock !== false

  useEffect(() => {
    if (!registered) {
      return undefined
    }

    return updates.addRefreshBlocker(() => {
      const current = latest.current

      return current === true || (current !== false && current())
    })
  }, [updates, registered])
}
