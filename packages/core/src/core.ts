import { ms, resolveEscalation } from './duration'
import { createEngine } from './engine'
import { browserHost, type Host } from './host'
import { createMachine } from './machine'
import { isolate } from './callbacks'
import { createReloads, type ReloadBlocker } from './reloads'
import { createSnoozes } from './snoozes'
import type {
  Duration,
  Escalation,
  ReloadFn,
  UpdateState,
  VersionInfo,
} from './types'

export type { ReloadBlocker } from './reloads'

export interface AppUpdatesOptions {
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

export interface CoreOptions extends AppUpdatesOptions {
  current: VersionInfo
  url: string
  host?: Host
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

function notifyAll(listeners: ReadonlySet<{ listener: () => void }>) {
  for (const entry of Array.from(listeners)) {
    isolate('listener', entry.listener)
  }
}

export function createAppUpdatesCore(o: CoreOptions): AppUpdates {
  const storageKey = o.storageKey ?? 'app-version'
  const listeners = new Set<{ listener: () => void }>()
  const host = o.host ?? browserHost()
  const snoozes = createSnoozes(storageKey, host)

  const reloads = createReloads({
    ...(o.reload && { reload: o.reload }),
    host,
  })

  const machine = createMachine({
    current: o.current,
    escalation: resolveEscalation(o.escalation),
    snoozes,
    notify: () => notifyAll(listeners),
  })

  const engine = createEngine({
    url: o.url,
    pollMs: pollMs(o.pollEvery),
    machine,
    snoozes,
    host,
  })

  return {
    getState: machine.getState,
    subscribe: subscribeTo(listeners, engine),
    addReloadBlocker: reloads.addBlocker,
    refresh: () => reloads.request({ href: host.location.href }),
    dismiss() {
      const dismissed = machine.dismiss()

      if (dismissed) {
        engine.reschedule()
      }

      return dismissed
    },
  }
}

function subscribeTo(
  listeners: Set<{ listener: () => void }>,
  engine: ReturnType<typeof createEngine>,
) {
  return (listener: () => void) => {
    const entry = { listener }
    listeners.add(entry)

    if (listeners.size === 1) {
      engine.start()
    }

    return () => {
      if (!listeners.delete(entry)) {
        return
      }

      if (listeners.size === 0) {
        engine.stop()
      }
    }
  }
}
