import { createPromptDismissal } from './prompt-dismissal'
import { createRefresh } from './refresh'
import { escalation, stickyUrgency } from './signals'
import { createTab, type Tab } from './tab'
import type { AppUpdates, AppUpdatesOptions } from './types'
import { createUpdateState } from './update-state'
import { createVersionCheck } from './version-check'

export type { BuildFacts } from './build-facts'

export type { Readable } from './readable'

export type { Refresh, RefreshBlocker, RefreshOutcome } from './refresh'

export type { Tab } from './tab'

export type {
  AppUpdates,
  AppUpdatesOptions,
  Attention,
  CheckProblem,
  UpdateReason,
  UpdateState,
  Updates,
} from './types'

export {
  createUpdateNotice,
  type UpdateNotice,
  type UpdateNoticeOptions,
} from './update-notice'

export { connectUpdateSurface, type UpdateSurface } from './update-surface'

/**
 * Create the app's updates without side effects, throwing an error that names
 * the option when one is invalid
 */
export function createAppUpdates(
  options: AppUpdatesOptions,
  tab: Tab = createTab(),
): AppUpdates {
  if (options.promptAfter === false && options.promptSnooze !== undefined) {
    throw new Error(
      '[usher] promptSnooze has no effect when promptAfter is false',
    )
  }

  return {
    state: createUpdateState(tab, {
      running: options.running,
      latest: createVersionCheck(tab, options),
      signals: [stickyUrgency(), escalation(options)],
      dismissal: createPromptDismissal(tab, options),
    }),
    refresh: createRefresh(tab, options),
  }
}
