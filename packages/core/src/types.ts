import * as v from 'valibot'

/** A string `Date.parse` can read; the policy orders builds by it. */
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
   * How long dismissing this level quiets it. Default: until the next level starts (prompt),
   * "30m" (urgent). A dismissal covers every tab whose level had already started.
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
  urgent?: EscalationLevel | false
}

/**
 * How loudly the app should signal an update. Each surface picks its own threshold:
 * a toast might show at "prompt"+, a nav-bar button at "passive"+.
 */
export type Attention = 'none' | 'passive' | 'prompt' | 'urgent'

/** Why attention is what it is, per level. Modeled on Base UI's `eventDetails.reason`. */
export interface ReasonsByAttention {
  /** unknown: not checked yet. caught-up: running the latest build. */
  none: 'unknown' | 'caught-up'
  /**
   * new-build: behind, nothing more. dismiss: a snooze holds a higher level back.
   * waiting: a higher level waits for an idle, visible tab. declined: onAttentionChange
   * canceled a higher level (offered again after the next check).
   */
  passive: 'new-build' | 'dismiss' | 'waiting' | 'declined'
  /** The running build passed `escalation.prompt.after`. */
  prompt: 'stale'
  /** rollback / forced: the running build is known bad (sticky until reload). expired: passed `escalation.urgent.after`. */
  urgent: 'rollback' | 'forced' | 'expired'
}
export type AttentionChangeReason = ReasonsByAttention[keyof ReasonsByAttention]
type Behind = Exclude<Attention, 'none'>

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

/** Where a change came from, for telemetry: one user dismiss shows up as "user" once, "other-tab" elsewhere. */
export type ChangeSource = 'check' | 'time' | 'user' | 'other-tab'

interface DetailsFor<A extends Attention> {
  /** Same as the first argument; narrow on it to narrow `reason`. */
  attention: A
  reason: ReasonsByAttention[A]
  previous: Attention
  latest: VersionInfo
  source: ChangeSource
  /**
   * Only raises and this tab's own dismiss can be canceled; lowerings, catching up, reason
   * changes within a level (`previous === attention`) and other tabs' dismissals are facts. A canceled raise is offered again after the next
   * successful check, or sooner if the target itself changes.
   */
  cancelable: boolean
  cancel: () => void
  readonly isCanceled: boolean
}
/** A discriminated union: `if (details.attention === "urgent") details.reason // "rollback" | "forced" | "expired"`. */
export type AttentionChangeDetails<A extends Attention = Attention> = {
  [K in A]: DetailsFor<K>
}[A]

export type ReloadReason =
  | 'navigate' // route change while behind (opt-in)
  | 'refresh' // refresh() called, e.g. a toast or nav button
  | 'chunk-error' // vite:preloadError

export interface ReloadDetails {
  reason: ReloadReason
  /** Where the reload goes. */
  href: string
}

/**
 * Performs a reload the store has decided on (after reload blockers allowed it).
 * Return or resolve `false` if it didn't happen, e.g. your router's blocker said no.
 * Default: `location.reload()` for the current URL, `location.assign(href)` otherwise.
 */
export type ReloadFn = (
  details: ReloadDetails,
) => void | boolean | Promise<void | boolean>

/**
 * Port the app implements so the core can reload on route changes.
 * Call `onNavigate` with the destination when your router fires before navigating,
 * or with nothing when it fires after. Return an unsubscribe function.
 */
export type SubscribeToNavigation = (
  onNavigate: (to?: { href: string }) => void,
) => () => void
