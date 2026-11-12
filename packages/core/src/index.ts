import { createAppUpdatesStore, type AppUpdates } from './app-updates'
import type { AppUpdatesOptions } from './types'

export type { AppUpdates, RefreshBlocker } from './app-updates'

export {
  connectUpdateSurface,
  type UpdateNotice,
  type UpdateSurface,
} from './update-surface'

export type {
  AppUpdatesOptions,
  Attention,
  BuildFacts,
  UpdateState,
} from './types'

/**
 * Create the app's update store, one per app at module scope.
 *
 * Creating it has no side effects. Polling, timers and listeners exist only while
 * there is at least one subscriber. Invalid options throw here, naming the option.
 */
export function createAppUpdates(options: AppUpdatesOptions): AppUpdates {
  return createAppUpdatesStore(options)
}
