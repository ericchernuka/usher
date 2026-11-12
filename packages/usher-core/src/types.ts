import * as valibot from 'valibot'

const Timestamp = valibot.pipe(valibot.string(), valibot.isoTimestamp())

const BuildFactsSchema = valibot.object({
  /** Source version the build came from, usually a commit SHA. Separate builds can share one. */
  version: valibot.pipe(valibot.string(), valibot.nonEmpty()),
  /** Commit time (ISO). Orders builds: lower than the running tab's = rollback. */
  commitTime: Timestamp,
  /** When the build ran (ISO). A tab is outdated from the build time of the first build that supersedes its own. */
  buildTime: Timestamp,
  /**
   * Tabs whose build ran before this time (ISO) must update. It is a build time,
   * not a deadline, and it cannot be later than this build's own `buildTime`.
   * Set via APP_FORCE_UPDATE_BUILT_BEFORE.
   */
  forceUpdateBuiltBefore: valibot.exactOptional(Timestamp),
})

/** Build facts shared by the running build and the serving deployment. */
export type BuildFacts = valibot.InferOutput<typeof BuildFactsSchema>

export const BUILD_FACT_NAMES = valibot.keyof(BuildFactsSchema).options

/** Reads build facts from untrusted input. Fields the schema does not know are dropped. */
export const parseBuildFacts = valibot.safeParser(BuildFactsSchema)

/**
 * How loudly the app should signal an update. Each surface picks its own threshold:
 * a toast might show at "prompt"+, a nav-bar button at "passive"+.
 */
export type Attention = 'none' | 'passive' | 'prompt' | 'urgent'

/**
 * One update state. `reason` always belongs to `attention`, and `latest` is present
 * once a check has landed, so `state.latest?.version` reads it without narrowing.
 *
 * - `unknown`: no check has landed yet.
 * - `caught-up`: the tab runs the latest build.
 * - `outdated`: a newer build is being served; attention says how loudly to ask.
 * - `dismissed`: the user dismissed the prompt.
 * - `rollback` / `forced`: sticky urgency, kept until the tab reloads.
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

/** Why the tab has the attention it has. */
export type UpdateReason = UpdateState['reason']

export interface AppUpdatesOptions {
  /** Build facts of the running build. */
  running: BuildFacts
  /** URL of the serving deployment's version.json. */
  versionUrl: string
  /**
   * How long, in milliseconds, a tab may stay outdated before it reaches prompt attention.
   * `false` turns the level off. Default 12 hours.
   */
  promptAfter?: number | false
  /**
   * How long, in milliseconds, a tab may stay outdated before it reaches urgent attention.
   * `false` turns the level off. Must be later than `promptAfter`. Default 24 hours.
   * Rollbacks and forced updates are urgent at once, whatever this says.
   */
  urgentAfter?: number | false
  /**
   * How long, in milliseconds, a prompt dismissal quiets prompt attention.
   * Default: until urgent attention starts. It never quiets urgent attention.
   */
  promptSnooze?: number
  /** How often, in milliseconds, a visible tab checks for a new build. Default 5 minutes, minimum 10 seconds. */
  pollInterval?: number
  /**
   * The page load a refresh performs, once refresh blockers allow it.
   * Return or resolve `false` when you know the reload did not happen; `refresh()`
   * then resolves `declined`. Default `location.reload()`.
   */
  reload?: () => void | boolean | Promise<void | boolean>
  /** Storage key prefix; set one per app if apps share an origin. Default "usher". */
  storageKey?: string
}
