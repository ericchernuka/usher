import { createPromptDismissal } from './prompt-dismissal'
import { createRefresh } from './refresh'
import { escalation, forcedUpdate, rollback } from './signals'
import { createTab, type Tab } from './tab'
import type { AppUpdates, AppUpdatesOptions } from './types'
import { createUpdateState } from './update-state'
import { createVersionCheck } from './version-check'

export type { BuildFacts } from './build-facts'

export type {
  EscalationOptions,
  PromptDismissalOptions,
  RefreshOptions,
  VersionCheckOptions,
} from './options'

export { createPromptDismissal, type PromptDismissal } from './prompt-dismissal'

export type { Readable } from './readable'

export {
  createRefresh,
  type Refresh,
  type RefreshBlocker,
  type RefreshOutcome,
} from './refresh'

export {
  defineSignal,
  escalation,
  forcedUpdate,
  rollback,
  type Asked,
  type Claim,
  type Moment,
  type Signal,
  type SignalDefinition,
} from './signals'

export { createTab, type Tab } from './tab'

export type {
  AppUpdates,
  AppUpdatesOptions,
  Attention,
  CheckProblem,
  UpdateReason,
  UpdateState,
} from './types'

export {
  createUpdateNotice,
  type Noticeable,
  type UpdateNotice,
  type UpdateNoticeOptions,
  type UpdateNoticeParts,
} from './update-notice'

export {
  createUpdateState,
  type UpdateStateOf,
  type UpdateStateParts,
  type Updates,
} from './update-state'

export { connectUpdateSurface, type UpdateSurface } from './update-surface'

export { createVersionCheck } from './version-check'

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
      signals: [forcedUpdate(), rollback(), escalation(options)],
      dismissal: createPromptDismissal(tab, options),
    }),
    refresh: createRefresh(tab, options),
  }
}
