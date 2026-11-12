import * as v from 'valibot'

const Timestamp = v.pipe(
  v.string(),
  v.check(value => !Number.isNaN(Date.parse(value))),
)

/** The runtime check for `version.json`; `VersionInfo` is derived from it, so they can't drift. */
export const VersionInfoSchema = v.object({
  /** Commit SHA the build came from. Equality = same build. */
  version: v.pipe(v.string(), v.nonEmpty()),
  /** Commit time (ISO). Orders builds: lower than the running tab's = rollback. */
  commitTime: Timestamp,
  /** When the build ran (ISO). Build age, the basis of escalation, counts from here. */
  builtAt: Timestamp,
  /** Tabs whose build ran before this time (ISO) must update. Set via APP_FORCE_UPDATE_BEFORE. */
  forceUpdateBefore: v.exactOptional(Timestamp),
})

/** Shape of `version.json` and of the `virtual:app-version` module. */
export type VersionInfo = v.InferOutput<typeof VersionInfoSchema>

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

/** Why attention is what it is, per level. */
export interface ReasonsByAttention {
  /** unknown: not checked yet. caught-up: running the latest build. */
  none: 'unknown' | 'caught-up'
  /** A newer build is available, or a prompt was dismissed. */
  passive: 'new-build' | 'dismiss'
  /** The running build passed `escalation.prompt.after`. */
  prompt: 'stale'
  /** rollback / forced: the running build is known bad (sticky until reload). expired: passed `escalation.urgent.after`. */
  urgent: 'rollback' | 'forced' | 'expired'
}

export type Behind = Exclude<Attention, 'none'>

/** One update state, as a union: impossible combinations (e.g. none + "dismiss") can't be expressed. */
export type UpdateState =
  | {
      attention: 'none'
      reason: ReasonsByAttention['none']
      latest?: VersionInfo
    }
  | {
      [A in Behind]: {
        attention: A
        reason: ReasonsByAttention[A]
        latest: VersionInfo
      }
    }[Behind]

/** The destination of an explicit refresh. */
export interface ReloadDetails {
  href: string
}

/** Return or resolve false when the app declines the refresh. */
export type ReloadFn = (
  details: ReloadDetails,
) => void | boolean | Promise<void | boolean>
