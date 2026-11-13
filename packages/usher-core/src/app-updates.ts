import { resolveOptions, type Thresholds } from './options'
import { LatestBuild } from './latest-build'
import { createServerClock } from './server-clock'
import type { Environment } from './environment'
import {
  resolveAttention,
  type Decision,
  type StickyUrgency,
} from './attention'
import { isolate } from './callbacks'
import {
  createRefresh,
  type RefreshBlocker,
  type RefreshOutcome,
} from './refresh'
import { createPromptDismissal } from './prompt-dismissal'
import {
  BUILD_FACT_NAMES,
  type AppUpdatesOptions,
  type BuildFacts,
  type UpdateState,
} from './types'

export type { RefreshBlocker, RefreshOutcome } from './refresh'

/**
 * The update store, one per app at module scope.
 *
 * Polling, timers and listeners exist only while there is at least one
 * subscriber. The state, the last observed build, the server clock estimate,
 * the time the tab became outdated and sticky urgency survive a gap with no
 * subscribers.
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
   * were added. Resolves `blocked` when one of them stopped it, `declined` when
   * `reload` returned `false` or threw, and `reloading` otherwise. Nothing is
   * remembered: a later call tries again. Concurrent calls share one attempt.
   */
  refresh: () => Promise<RefreshOutcome>
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

function sameState(next: UpdateState, current: UpdateState) {
  if (next.attention !== current.attention || next.reason !== current.reason) {
    return false
  }

  const [nextLatest, currentLatest] = [next.latest, current.latest]

  if (!nextLatest || !currentLatest) {
    return nextLatest === currentLatest
  }

  return BUILD_FACT_NAMES.every(
    fact => nextLatest[fact] === currentLatest[fact],
  )
}

function notifyAll(listeners: ReadonlySet<{ listener: () => void }>) {
  for (const entry of Array.from(listeners)) {
    if (listeners.has(entry)) {
      isolate('listener', entry.listener)
    }
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1

interface Active {
  stopListening: () => void
  cancelDeadline?: (() => void) | undefined
}

export class AppUpdatesStore implements AppUpdates {
  readonly running: BuildFacts
  readonly env: Environment
  readonly thresholds: Thresholds
  readonly clock: ReturnType<typeof createServerClock>
  readonly dismissal: ReturnType<typeof createPromptDismissal>
  readonly refreshes: ReturnType<typeof createRefresh>
  readonly latestBuild: LatestBuild
  readonly listeners = new Set<{ listener: () => void }>()
  state: UpdateState = { attention: 'none', reason: 'unknown' }
  stickyUrgency: StickyUrgency | undefined
  outdatedSince: number | undefined
  active: Active | undefined

  constructor(options: AppUpdatesOptions, env: Environment) {
    const resolved = resolveOptions(options)
    this.running = resolved.running
    this.env = env
    this.thresholds = resolved
    this.clock = createServerClock(env)
    this.dismissal = createPromptDismissal(resolved.storageKey, env)
    this.refreshes = createRefresh(options.reload ?? (() => env.reload()))
    this.latestBuild = new LatestBuild({
      versionUrl: resolved.versionUrl,
      pollInterval: resolved.pollInterval,
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
          outdatedSince: this.outdatedSince,
          dismissedAt,
          thresholds: this.thresholds,
        })
      : undefined
  }

  apply = (decision: Decision) => {
    this.stickyUrgency = decision.stickyUrgency
    this.outdatedSince = decision.outdatedSince
    this.scheduleDeadline(decision.nextAt)
    this.publish(decision.state)
  }

  evaluate = () => {
    const decision = this.decide()

    if (decision) {
      this.apply(decision)
    }
  }

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
