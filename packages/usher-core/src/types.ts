import * as v from 'valibot'

const Timestamp = v.pipe(
  v.string(),
  v.check(value => !Number.isNaN(Date.parse(value))),
)

/** The runtime check for `version.json`; `BuildFacts` is derived from it, so they can't drift. */
const BuildFactsSchema = v.object({
  /** Source version the build came from, usually a commit SHA. Separate builds can share one. */
  version: v.pipe(v.string(), v.nonEmpty()),
  /** Commit time (ISO). Orders builds: lower than the running tab's = rollback. */
  commitTime: Timestamp,
  /** When the build ran (ISO). Build age, the basis of escalation, counts from here. */
  buildTime: Timestamp,
  /** Tabs whose build ran before this time (ISO) must update. Set via APP_FORCE_UPDATE_BEFORE. */
  forceUpdateBefore: v.exactOptional(Timestamp),
})

/** Build facts shared by the running build and the serving deployment. */
export type BuildFacts = v.InferOutput<typeof BuildFactsSchema>

export function isBuildFacts(value: unknown): value is BuildFacts {
  return v.is(BuildFactsSchema, value)
}

/**
 * How loudly the app should signal an update. Each surface picks its own threshold:
 * a toast might show at "prompt"+, a nav-bar button at "passive"+.
 */
export type Attention = 'none' | 'passive' | 'prompt' | 'urgent'

/**
 * One update state. `reason` always belongs to `attention`, and `latest` is present
 * once a check has landed.
 *
 * - `unknown`: no check has landed yet.
 * - `caught-up`: the tab runs the latest build.
 * - `outdated`: a newer build is being served; attention says how loudly to ask.
 * - `dismissed`: the user dismissed the prompt.
 * - `rollback` / `forced`: sticky urgency, kept until the tab reloads.
 */
export type UpdateState =
  | { attention: 'none'; reason: 'unknown' }
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

export interface AppUpdatesOptions {
  /** Build facts of the running build. */
  running: BuildFacts
  /** URL of the serving deployment's version.json. */
  versionUrl: string
  /**
   * Build age, in milliseconds, at which an outdated tab reaches prompt attention.
   * `false` turns the level off. Default 12 hours.
   */
  promptAfter?: number | false
  /**
   * Build age, in milliseconds, at which an outdated tab reaches urgent attention.
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
   * Return or resolve `false` when the reload did not happen. Default `location.reload()`.
   * Route it through your router to reuse its blockers; see the README recipe.
   */
  reload?: () => void | boolean | Promise<void | boolean>
  /** Storage key prefix; set one per app if apps share an origin. Default "usher". */
  storageKey?: string
}
