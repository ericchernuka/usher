// The update store: a thin assembly of the state machine (machine.ts), the DOM engine
// (engine.ts) and reloads (reloads.ts) behind a five-method external store.
import { ms, resolveEscalation } from './duration'
import { createEngine } from './engine'
import { browserHost, type Host } from './host'
import { createMachine, isolate } from './machine'
import { createReloads, type ReloadBlocker } from './reloads'
import { createSnoozes } from './snoozes'
import type {
  Attention,
  AttentionChangeDetails,
  Duration,
  Escalation,
  ReloadFn,
  SubscribeToNavigation,
  UpdateState,
  VersionInfo,
} from './types'

export type { ReloadBlocker } from './reloads'

export interface AppUpdatesOptions {
  /** When outdated tabs escalate, by build age. Default `{ prompt: { after: "12h" }, urgent: { after: "24h", snooze: "30m" } }`. */
  escalation?: Escalation
  /**
   * Told about every attention or reason change, with Base UI-style details. Raises and this tab's own
   * dismiss can be canceled (`details.cancelable`); a canceled raise is offered again after
   * the next successful check. `details` is a union: narrow on `details.attention`.
   */
  onAttentionChange?: (
    attention: Attention,
    details: AttentionChangeDetails,
  ) => void
  /**
   * Performs a "refresh" or "navigate" reload, after reload blockers allow it. Route it
   * through your router to reuse its blockers, e.g. TanStack
   * `router.navigate({ href, reloadDocument: true, replace: true })`. See README.
   */
  reload?: ReloadFn
  /** Optional, off by default: reload on the next route change when behind. See README. */
  subscribeToNavigation?: SubscribeToNavigation
  /** Reload once if a lazy chunk fails to load. Default true. */
  reloadOnChunkError?: boolean
  /** How often a visible tab checks for a new build. Hidden tabs don't. Default "5m", minimum "10s". */
  pollEvery?: Duration
  /** Input-idle time before raising to prompt/urgent, so a toast never lands mid-keystroke. Default "5s". */
  idleFor?: Duration
  /** localStorage key prefix; set one per app if apps share an origin. */
  storageKey?: string
}

/** Internal: build info normally comes from `virtual:app-version`; tests pass it directly. */
export interface CoreOptions extends AppUpdatesOptions {
  current: VersionInfo
  url: string
  /** The browser surface; tests substitute a fake. Default: the real globals. */
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
  /** Dismiss the current prompt/urgent for every tab. Decides first: true, and effects, only if attention drops. */
  dismiss: () => boolean
}

const MIN_POLL_MS = 10_000

function pollMs(value: Duration = '5m'): number {
  const result = ms(value, 'pollEvery')
  if (result < MIN_POLL_MS)
    throw new Error(`[app-version] pollEvery must be at least "10s"`)
  return result
}

export function createAppUpdatesCore(o: CoreOptions): AppUpdates {
  const storageKey = o.storageKey ?? 'app-version'
  const listeners = new Set<{ listener: () => void }>()
  const host = o.host ?? browserHost()
  const snoozes = createSnoozes(storageKey, host)
  const reloads = createReloads({
    ...(o.reload && { reload: o.reload }),
    storageKey,
    host,
  })
  const machine = createMachine({
    current: o.current,
    escalation: resolveEscalation(o.escalation), // validates eagerly: bad config throws here
    snoozes,
    ...(o.onAttentionChange && { onAttentionChange: o.onAttentionChange }),
    notify: () => {
      // Snapshot: a listener may (un)subscribe while we notify.
      for (const entry of Array.from(listeners))
        isolate('listener', entry.listener)
    },
  })
  const engine = createEngine({
    url: o.url,
    pollMs: pollMs(o.pollEvery),
    idleMs: ms(o.idleFor ?? '5s', 'idleFor'),
    machine,
    snoozes,
    reloads,
    ...(o.subscribeToNavigation && {
      subscribeToNavigation: o.subscribeToNavigation,
    }),
    reloadOnChunkError: o.reloadOnChunkError ?? true,
    host,
  })

  return {
    getState: machine.getState,
    subscribe(listener) {
      const entry = { listener } // a token per call, so the same function can subscribe twice
      listeners.add(entry)
      if (listeners.size === 1) engine.start()
      return () => {
        if (!listeners.delete(entry)) return
        if (listeners.size === 0) engine.stop()
      }
    },
    addReloadBlocker: reloads.addBlocker,
    refresh: () =>
      reloads.request({ reason: 'refresh', href: host.location.href }),
    dismiss() {
      const dismissed = machine.dismiss(engine.context('user'))
      if (dismissed) engine.reschedule()
      return dismissed
    },
  }
}
