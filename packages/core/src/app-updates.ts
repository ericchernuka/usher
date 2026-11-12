import { ms, resolveEscalation, type ResolvedEscalation } from './duration'
import { createUpdateMonitor } from './update-monitor'
import { createBrowserEnvironment, type BrowserEnvironment } from './browser'
import { resolveAttention, type StickyUrgency } from './attention'
import { isolate } from './callbacks'
import { createRefresh, type ReloadBlocker } from './refresh'
import { createPromptDismissal } from './prompt-dismissal'
import type {
  Duration,
  Escalation,
  ReloadFn,
  UpdateState,
  BuildFacts,
} from './types'

export type { ReloadBlocker } from './refresh'

export interface AppUpdatesOptions {
  /** Build facts of the running build. */
  running: BuildFacts
  /** URL of the serving deployment's version.json. */
  versionUrl: string
  /** When outdated tabs escalate, by build age. Default `{ prompt: { after: "12h" }, urgent: { after: "24h" } }`. */
  escalation?: Escalation
  /**
   * Performs an explicit refresh, after reload blockers allow it. Route it
   * through your router to reuse its blockers, e.g. TanStack
   * `router.navigate({ href, reloadDocument: true, replace: true })`. See README.
   */
  reload?: ReloadFn
  /** How often a visible tab checks for a new build. Hidden tabs don't. Default "5m", minimum "10s". */
  pollEvery?: Duration
  /** localStorage key prefix; set one per app if apps share an origin. */
  storageKey?: string
}

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
  /** Register a synchronous reload veto (e.g. unsaved work); returns a cleanup. */
  addReloadBlocker: (blocker: ReloadBlocker) => () => void
  /** Reload onto the latest build. Resolves false if a blocker or your `reload` declined. Concurrent calls share one reload. */
  refresh: () => Promise<boolean>
  /** Dismiss the current prompt for every tab. Urgent states cannot be dismissed. */
  dismiss: () => boolean
}

const MIN_POLL_MS = 10_000

function pollMs(value: Duration = '5m'): number {
  const result = ms(value, 'pollEvery')

  if (result < MIN_POLL_MS) {
    throw new Error(`[app-version] pollEvery must be at least "10s"`)
  }

  return result
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

class AppUpdatesStore implements AppUpdates {
  readonly options: UpdateStoreOptions
  readonly browser: BrowserEnvironment
  readonly escalation: ResolvedEscalation
  readonly dismissal: ReturnType<typeof createPromptDismissal>
  readonly refreshes: ReturnType<typeof createRefresh>
  readonly monitor: ReturnType<typeof createUpdateMonitor>
  readonly listeners = new Set<{ listener: () => void }>()
  state: UpdateState = { attention: 'none', reason: 'unknown' }
  latest: BuildFacts | undefined
  stickyUrgency: StickyUrgency | undefined

  constructor(options: UpdateStoreOptions) {
    this.options = options
    this.browser = options.browser ?? createBrowserEnvironment()
    this.escalation = resolveEscalation(options.escalation)
    this.dismissal = createPromptDismissal(
      options.storageKey ?? 'app-version',
      this.browser,
    )
    this.refreshes = createRefresh({
      ...(options.reload && { reload: options.reload }),
      browser: this.browser,
    })
    this.monitor = createUpdateMonitor({
      versionUrl: options.versionUrl,
      pollMs: pollMs(options.pollEvery),
      browser: this.browser,
      dismissal: this.dismissal,
      evaluate: this.evaluate,
      nextDeadline: () => this.decision()?.nextAt,
    })
  }

  decision = (dismissal = this.dismissal.get()) =>
    this.latest
      ? resolveAttention({
          running: this.options.running,
          latest: this.latest,
          now: this.monitor.serverNow(),
          ...(this.stickyUrgency && { stickyUrgency: this.stickyUrgency }),
          dismissal,
          escalation: this.escalation,
        })
      : undefined

  evaluate = (latest = this.latest) => {
    this.latest = latest
    const result = this.decision()

    if (result) {
      this.stickyUrgency = result.stickyUrgency
      this.publish(result.state)
    }
  }

  publish = (next: UpdateState) => {
    if (sameState(next, this.state)) {
      return
    }

    this.state = next
    notifyAll(this.listeners)
  }

  getState = () => this.state

  subscribe = (listener: () => void) => {
    const entry = { listener }
    this.listeners.add(entry)

    if (this.listeners.size === 1) {
      this.monitor.start()
    }

    return () => {
      if (!this.listeners.delete(entry)) {
        return
      }

      if (this.listeners.size === 0) {
        this.monitor.stop()
      }
    }
  }

  addReloadBlocker = (blocker: ReloadBlocker) =>
    this.refreshes.addBlocker(blocker)

  refresh = () => this.refreshes.request({ href: this.browser.location.href })

  dismiss = (): boolean => {
    if (this.state.attention !== 'prompt') {
      return false
    }

    const proposed = { dismissedAt: this.monitor.serverNow() }
    const result = this.decision(proposed)

    if (
      result?.state.attention !== 'passive' ||
      result.state.reason !== 'dismissed'
    ) {
      return false
    }

    this.dismissal.write(proposed)
    this.publish(result.state)
    this.monitor.reschedule()

    return true
  }
}

export function createAppUpdatesStore(options: UpdateStoreOptions): AppUpdates {
  return new AppUpdatesStore(options)
}
