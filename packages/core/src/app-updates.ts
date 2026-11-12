import {
  resolvePollInterval,
  resolveThresholds,
  type Thresholds,
} from './options'
import { createLatestBuild } from './latest-build'
import { createServerClock } from './server-clock'
import {
  createBrowserEnvironment,
  listen,
  type BrowserEnvironment,
} from './browser'
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

export interface UpdateStoreOptions extends AppUpdatesOptions {
  browser?: BrowserEnvironment
}

/**
 * External store, one per app at module scope. Creating it has no side effects;
 * it polls while it has at least one subscriber.
 */
export interface AppUpdates {
  getState: () => UpdateState
  /** Each call is its own subscription, even with the same function. */
  subscribe: (listener: () => void) => () => void
  /** Register a synchronous veto on refresh (e.g. unsaved work); returns a cleanup. */
  addRefreshBlocker: (blocker: RefreshBlocker) => () => void
  /** Refresh onto the latest build. Resolves false if a blocker or your `reload` declined. Concurrent calls share one attempt. */
  refresh: () => Promise<boolean>
  /** Dismiss the current prompt for every tab. Urgent states cannot be dismissed. */
  dismiss: () => boolean
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
  deadline?: ReturnType<typeof setTimeout> | undefined
}

class AppUpdatesStore implements AppUpdates {
  readonly running: BuildFacts
  readonly browser: BrowserEnvironment
  readonly thresholds: Thresholds
  readonly clock: ReturnType<typeof createServerClock>
  readonly dismissal: ReturnType<typeof createPromptDismissal>
  readonly refreshes: ReturnType<typeof createRefresh>
  readonly latestBuild: ReturnType<typeof createLatestBuild>
  readonly listeners = new Set<{ listener: () => void }>()
  state: UpdateState = { attention: 'none', reason: 'unknown' }
  stickyUrgency: StickyUrgency | undefined
  active: Active | undefined

  constructor(options: UpdateStoreOptions) {
    const browser = options.browser ?? createBrowserEnvironment()
    this.running = options.running
    this.browser = browser
    this.thresholds = resolveThresholds(options)
    this.clock = createServerClock()
    this.dismissal = createPromptDismissal(
      options.storageKey ?? 'app-version',
      browser,
    )
    this.refreshes = createRefresh(
      options.reload ?? (() => browser.location.reload()),
    )
    this.latestBuild = createLatestBuild({
      versionUrl: options.versionUrl,
      pollInterval: resolvePollInterval(options.pollInterval),
      browser,
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

    clearTimeout(this.active.deadline)
    this.active.deadline = undefined

    if (
      nextAt === undefined ||
      this.browser.document.visibilityState !== 'visible'
    ) {
      return
    }

    const delay = Math.min(Math.max(0, nextAt - this.clock.now()), MAX_TIMER_MS)
    this.active.deadline = setTimeout(this.evaluate, delay)
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
      stopListening: listen(
        this.browser.document,
        'visibilitychange',
        this.evaluate,
      ),
    }
    this.dismissal.start(this.evaluate)
    this.latestBuild.start(this.evaluate)
    this.evaluate()
  }

  stop = () => {
    if (!this.active) {
      return
    }

    const { stopListening, deadline } = this.active
    this.active = undefined
    clearTimeout(deadline)
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

export function createAppUpdatesStore(options: UpdateStoreOptions): AppUpdates {
  return new AppUpdatesStore(options)
}
