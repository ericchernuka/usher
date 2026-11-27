import type { BuildFacts } from './build-facts'
import type {
  EscalationOptions,
  PromptDismissalOptions,
  RefreshOptions,
  VersionCheckOptions,
} from './options'
import type { Readable } from './readable'
import type { Refresh } from './refresh'

/**
 * How loudly the app should signal an update. Each surface picks its own threshold:
 * a toast might show at "prompt"+, a nav-bar button at "passive"+.
 */
export type Attention = 'none' | 'passive' | 'prompt' | 'urgent'

/** Attention from quietest to loudest, for comparing two levels */
export const attentionRank = {
  none: 0,
  passive: 1,
  prompt: 2,
  urgent: 3,
} as const satisfies Record<Attention, number>

/**
 * One update state. `reason` always belongs to `attention`, and `latest` is present
 * once a check has landed, so `state.latest?.version` reads it without narrowing.
 *
 * - `unknown`: no check has landed yet.
 * - `caught-up`: the running app is on the latest build.
 * - `outdated`: a newer build is being served; attention says how loudly to ask.
 * - `dismissed`: the user dismissed the prompt.
 * - `rollback` / `forced`: sticky urgency, kept until the app reloads.
 */
export type UpdateState =
  | { attention: 'none'; reason: 'unknown'; latest?: undefined }
  | { attention: 'none'; reason: 'caught-up'; latest: BuildFacts }
  | {
      attention: 'passive'
      reason: 'outdated' | 'dismissed'
      latest: BuildFacts
    }
  | { attention: 'prompt'; reason: 'outdated'; latest: BuildFacts }
  | {
      attention: 'urgent'
      reason: 'outdated' | 'rollback' | 'forced'
      latest: BuildFacts
    }

/** Why the running app has the attention it has. */
export type UpdateReason = UpdateState['reason']

/**
 * A version check that cannot get build facts for a reason the deployment can
 * fix. `versionUrl` is the version check's own `versionUrl` option.
 *
 * - `request-failed`: the browser was online but the request failed before any
 *   response arrived, as when the page's Content-Security-Policy `connect-src`
 *   does not allow the version URL.
 * - `http-error`: the response was not OK.
 * - `not-json`: the body could not be read as JSON, as when a host answers with
 *   its HTML fallback. `contentType` is the response's header, if it had one.
 * - `not-build-facts`: the JSON was the wrong shape. `issues` says what was
 *   wrong, in words for a person.
 */
export type CheckProblem =
  | { kind: 'request-failed'; versionUrl: string }
  | { kind: 'http-error'; versionUrl: string; status: number }
  | { kind: 'not-json'; versionUrl: string; contentType: string | null }
  | { kind: 'not-build-facts'; versionUrl: string; issues: string }

/** Options for `createAppUpdates`, checked when it is called */
export interface AppUpdatesOptions
  extends
    VersionCheckOptions,
    EscalationOptions,
    PromptDismissalOptions,
    RefreshOptions {
  /** Build facts of the running build */
  running: BuildFacts
}

/** Update state of the running app, checked for a new build while subscribed */
export interface Updates extends Readable<UpdateState> {
  /**
   * Prompt dismissal for every open window or tab on the same origin, `true` only when it lowered a prompt
   * and `false` with nothing written otherwise
   */
  dismiss: () => boolean
}

/** The app's updates, one per app at module scope */
export interface AppUpdates {
  /** Update state and prompt dismissal */
  state: Updates
  /** Refresh onto the latest build, with its blockers */
  refresh: Refresh
}
