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

/** A duration such as "30s", "5m", "12h" or "2d". Checked at runtime too ("-5m", "1e3s" throw). */
export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`

export interface EscalationLevel {
  /** Build age (server clock) at which this level starts. */
  after: Duration
  /**
   * How long dismissing a prompt quiets it. Default: until urgent starts.
   * A dismissal covers every tab whose prompt level had already started.
   */
  snooze?: Duration
}

/**
 * When an outdated tab escalates, by the age of the build it's running. `false` turns a
 * level off. Known-bad builds (rollback, forced) are always urgent, independent of age.
 * Defaults follow Vercel's skew-protection max ages: prompt at 12 h (Pro), urgent at 24 h (Enterprise).
 */
export interface Escalation {
  prompt?: EscalationLevel | false
  urgent?: Pick<EscalationLevel, 'after'> | false
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

/** The destination of an explicit refresh. */
export interface ReloadDetails {
  href: string
}

/** Return or resolve false when the app declines the refresh. */
export type ReloadFn = (
  details: ReloadDetails,
) => void | boolean | Promise<void | boolean>
