import { useDeferredValue, useEffect, useSyncExternalStore } from 'react'
import type { AppUpdates, RefreshBlocker, UpdateState } from '@app-version/core'

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
 *
 *   useRefreshBlocker(appUpdates, form.isDirty)
 */
export function useRefreshBlocker(
  updates: AppUpdates,
  shouldBlock: boolean | RefreshBlocker,
): void {
  useEffect(() => {
    if (shouldBlock === false) {
      return undefined
    }

    return updates.addRefreshBlocker(
      shouldBlock === true ? () => true : shouldBlock,
    )
  }, [updates, shouldBlock])
}
