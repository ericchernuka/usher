import {
  createAppUpdatesStore,
  type AppUpdates,
  type AppUpdatesOptions,
} from './app-updates'

export type {
  AppUpdates,
  AppUpdatesOptions,
  ReloadBlocker,
} from './app-updates'

export {
  connectPrompt,
  defaultCopy,
  PROMPT_ID,
  type Prompt,
  type PromptBase,
  type PromptAdapter,
  type PromptCopy,
} from './prompt'

export type {
  Attention,
  Behind,
  Duration,
  Escalation,
  EscalationLevel,
  ReasonsByAttention,
  ReloadDetails,
  ReloadFn,
  UpdateState,
  VersionInfo,
} from './types'

/**
 * Create the app's update store with the running build and version URL.
 * No side effects until the first subscribe(); polls while subscribed.
 */
export function createAppUpdates(options: AppUpdatesOptions): AppUpdates {
  return createAppUpdatesStore(options)
}
