import { AppUpdatesStore, type AppUpdates } from './app-updates'
import { createBrowserEnvironment } from './environment'
import type { AppUpdatesOptions } from './types'

export type { AppUpdates, RefreshBlocker, RefreshOutcome } from './app-updates'

export {
  connectUpdateSurface,
  type UpdateNotice,
  type UpdateSurface,
} from './update-surface'

export type { BuildFacts } from './build-facts'

export type {
  AppUpdatesOptions,
  Attention,
  UpdateReason,
  UpdateState,
} from './types'

/**
 * Create the app's update store, one per app at module scope.
 *
 * Creating it has no side effects. Polling, timers and listeners exist only while
 * there is at least one subscriber. Invalid options throw here, naming the option.
 */
export function createAppUpdates(options: AppUpdatesOptions): AppUpdates {
  return new AppUpdatesStore(options, createBrowserEnvironment())
}
