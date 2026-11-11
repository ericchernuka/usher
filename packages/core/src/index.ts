import { appVersion, versionUrl } from 'virtual:app-version'
import {
  createAppUpdatesCore,
  type AppUpdates,
  type AppUpdatesOptions,
} from './core'

export type { AppUpdates, AppUpdatesOptions, ReloadBlocker } from './core'

export {
  connectPrompt,
  defaultCopy,
  PROMPT_ID,
  type Prompt,
  type PromptAdapter,
  type PromptCopy,
} from './prompt'

export type {
  Attention,
  AttentionChangeDetails,
  AttentionChangeReason,
  ChangeSource,
  Duration,
  Escalation,
  EscalationLevel,
  ReasonsByAttention,
  ReloadDetails,
  ReloadFn,
  ReloadReason,
  SubscribeToNavigation,
  UpdateState,
  VersionInfo,
} from './types'

/**
 * Create the app's update store. Call once at module scope.
 * No side effects until the first subscribe(); polls while subscribed.
 */
export function createAppUpdates(options: AppUpdatesOptions = {}): AppUpdates {
  return createAppUpdatesCore({
    ...options,
    current: appVersion,
    url: versionUrl,
  })
}
