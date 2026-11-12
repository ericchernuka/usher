import {
  resolvePollInterval,
  resolveThresholds,
  type Thresholds,
} from './options'
import { createLatestBuild } from './latest-build'
import { createServerClock } from './server-clock'
import { createBrowserEnvironment, type Environment } from './environment'
import {
  resolveAttention,
  type Decision,
  type StickyUrgency,
} from './attention'
import { isolate } from './callbacks'
import { createRefresh, type RefreshBlocker } from './refresh'
import { createPromptDismissal } from './prompt-dismissal'
import type { AppUpdatesOptions, BuildFacts, UpdateState } from './types'

export type { RefreshBlocker } from './refresh'

/**
 * The update store, one per app at module scope.
 *
 * Polling, timers and listeners exist only while there is at least one
 * subscriber. The state, the last observed build, the server clock estimate and
 * sticky urgency survive a gap with no subscribers.
 */
export interface AppUpdates {
  /**
   * The current snapshot. It is the same object until attention, reason or any
   * field of `latest` changes, so it is safe for `useSyncExternalStore`.
   */
  getState: () => UpdateState
  /**
   * Listen for state changes. Listeners run after the new state is readable, and
   * one that throws does not stop the others. Each call is its own
   * subscription, even with the same function.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Refresh onto the latest build. Blockers run synchronously in the order they
   * were added. Resolves `false` when a blocker blocked it, or when `reload`
   * returned `false` or threw; a later call may try again. Concurrent calls
   * share one attempt.
   */
  refresh: () => Promise<boolean>
  /**
   * Dismiss the prompt for every tab. Returns `true` only when the state was
   * `prompt` and is now `passive` / `dismissed`. Otherwise it returns `false`
   * and writes nothing; urgent attention cannot be dismissed.
   */
  dismiss: () => boolean
  /**
   * Register a synchronous veto on refresh, for example for unsaved work. A
   * blocker that returns `true` or throws blocks the refresh. Returns a cleanup.
   */
  addRefreshBlocker: (blocker: RefreshBlocker) => () => void
}

const FACTS = [
  'version',
  'commitTime',
  'buildTime',
  'forceUpdateBefore',
] as const satisfies ReadonlyArray<keyof BuildFacts>

function sameState(a: UpdateState, b: UpdateState) {
  if (a.attention !== b.attention || a.reason !== b.reason) {
    return false
  }

  if (!('latest' in a) || !('latest' in b)) {
    return true
  }

  const [x, y] = [a.latest, b.latest]

  return FACTS.every(fact => x[fact] === y[fact])
}

function notifyAll(listeners: ReadonlySet<{ listener: () => void }>) {
  for (const entry of Array.from(listeners)) {
    isolate('listener', entry.listener)
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1

interface Active {
  stopListening: () => void
  cancelDeadline?: (() => void) | undefined
}

class AppUpdatesStore implements AppUpdates {
  readonly running: BuildFacts
  readonly env: Environment
  readonly thresholds: Thresholds
  readonly clock: ReturnType<typeof createServerClock>
  readonly dismissal: ReturnType<typeof createPromptDismissal>
  readonly refreshes: ReturnType<typeof createRefresh>
  readonly latestBuild: ReturnType<typeof createLatestBuild>
  readonly listeners = new Set<{ listener: () => void }>()
  state: UpdateState = { attention: 'none', reason: 'unknown' }
  stickyUrgency: StickyUrgency | undefined
  active: Active | undefined

  constructor(options: AppUpdatesOptions, env: Environment) {
    this.running = options.running
    this.env = env
    this.thresholds = resolveThresholds(options)
    this.clock = createServerClock(env)
    this.dismissal = createPromptDismissal(options.storageKey ?? 'usher', env)
    this.refreshes = createRefresh(options.reload ?? (() => env.reload()))
    this.latestBuild = createLatestBuild({
      versionUrl: options.versionUrl,
      pollInterval: resolvePollInterval(options.pollInterval),
      env,
      clock: this.clock,
    })
  }

  decide = (dismissedAt = this.dismissal.get()): Decision | undefined => {
    const latest = this.latestBuild.get()

    return latest
      ? resolveAttention({
          running: this.running,
          latest,
          now: this.clock.now(),
          stickyUrgency: this.stickyUrgency,
          dismissedAt,
          thresholds: this.thresholds,
        })
      : undefined
  }

  apply = (decision: Decision) => {
    this.stickyUrgency = decision.stickyUrgency
    this.publish(decision.state)
    this.scheduleDeadline(decision.nextAt)
  }

  /** Every source calls back here: a new response, a storage change, a deadline, visibility. */
  evaluate = () => {
    const decision = this.decide()

    if (decision) {
      this.apply(decision)
    }
  }

  /** One timer for the next moment attention changes on its own. Hidden tabs keep none. */
  scheduleDeadline = (nextAt: number | undefined) => {
    if (!this.active) {
      return
    }

    this.active.cancelDeadline?.()
    this.active.cancelDeadline = undefined

    if (nextAt === undefined || !this.env.isVisible()) {
      return
    }

    const delay = Math.min(Math.max(0, nextAt - this.clock.now()), MAX_TIMER_MS)
    this.active.cancelDeadline = this.env.startTimer(this.evaluate, delay)
  }

  publish = (next: UpdateState) => {
    if (sameState(next, this.state)) {
      return
    }

    this.state = next
    notifyAll(this.listeners)
  }

  start = () => {
    this.active = {
      stopListening: this.env.onVisibilityChange(this.evaluate),
    }
    this.dismissal.start(this.evaluate)
    this.latestBuild.start(this.evaluate)
    this.evaluate()
  }

  stop = () => {
    if (!this.active) {
      return
    }

    const { stopListening, cancelDeadline } = this.active
    this.active = undefined
    cancelDeadline?.()
    stopListening()
    this.latestBuild.stop()
    this.dismissal.stop()
  }

  getState = () => this.state

  subscribe = (listener: () => void) => {
    const entry = { listener }
    this.listeners.add(entry)

    if (this.listeners.size === 1) {
      this.start()
    }

    return () => {
      if (this.listeners.delete(entry) && this.listeners.size === 0) {
        this.stop()
      }
    }
  }

  addRefreshBlocker = (blocker: RefreshBlocker) =>
    this.refreshes.addBlocker(blocker)

  refresh = () => this.refreshes.request()

  dismiss = (): boolean => {
    if (this.state.attention !== 'prompt') {
      return false
    }

    const at = this.clock.now()
    const decision = this.decide(at)

    if (
      decision?.state.attention !== 'passive' ||
      decision.state.reason !== 'dismissed'
    ) {
      return false
    }

    this.dismissal.record(at)
    this.apply(decision)

    return true
  }
}

/** The factory behind `createAppUpdates`. Tests inside core pass a fake environment. */
export function createAppUpdatesStore(
  options: AppUpdatesOptions,
  env: Environment = createBrowserEnvironment(),
): AppUpdates {
  return new AppUpdatesStore(options, env)
}
