// Internal. The DOM side: lifecycle, inputs, the one timer, and fetching version.json.
//
// Every input calls the machine and then `reschedule()`, which derives the single wake-up
// from deadlines: next poll, the policy's own deadlines (thresholds, snooze expiry), and
// idle release while a raise is held. Every wake re-evaluates first, so time-based changes
// happen even when fetches fail. Hidden tabs have no wake timer (an in-flight fetch keeps
// its own timeout until it settles).
import type { Host, StorageChange } from './host'
import * as v from 'valibot'
import { isVersionInfo } from './policy'
import type { createMachine, Context } from './machine'
import type { createReloads } from './reloads'
import type { createSnoozes } from './snoozes'
import type { ChangeSource, SubscribeToNavigation, VersionInfo } from './types'

const MIN = 60_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1 // larger delays fire immediately in browsers

export interface EngineDeps {
  url: string
  pollMs: number
  idleMs: number
  machine: ReturnType<typeof createMachine>
  snoozes: ReturnType<typeof createSnoozes>
  reloads: ReturnType<typeof createReloads>
  subscribeToNavigation?: SubscribeToNavigation
  reloadOnChunkError: boolean
  host: Host
}

type Running = {
  cleanups: Array<() => void>
  /** The one fetch in progress; a newer check() or stop() aborts it. */
  inFlight?: AbortController | undefined
  /** The one wake-up timer (never set while hidden). */
  wake?: ReturnType<typeof setTimeout> | undefined
}

/** Monotonic: polling and idleness survive the user's clock jumping. Policy times stay on Date. */
const tick = () => performance.now()

/** A valid version.json and the server time, or undefined (bad status, aborted, malformed). */
async function readResponse(res: Response, signal: AbortSignal) {
  if (!res.ok) {
    return undefined
  }

  const body: unknown = await res.json()

  if (signal.aborted) {
    return undefined
  }

  if (!isVersionInfo(body)) {
    return console.warn('[app-version] ignoring malformed version.json', body)
  }

  // Cross-origin responses need `Access-Control-Expose-Headers: Date` for this; else no correction.
  const serverDate = Date.parse(res.headers.get('date') ?? '')

  return {
    latest: body,
    serverTime: Number.isNaN(serverDate) ? undefined : serverDate,
  }
}

const StorageFields = v.object({
  key: v.nullable(v.string()),
  newValue: v.nullable(v.string()),
})

function readStorageChange(
  event: Event,
  host: Host,
): StorageChange | undefined {
  try {
    const storageArea = host.localStorage

    if (!('storageArea' in event) || event.storageArea !== storageArea) {
      return undefined
    }

    const parsed = v.safeParse(StorageFields, event)

    return parsed.success ? { ...parsed.output, storageArea } : undefined
  } catch {
    return undefined // Storage access can be denied by browser settings.
  }
}

class Engine {
  readonly deps: EngineDeps

  constructor(deps: EngineDeps) {
    this.deps = deps
  }
  visible = () => this.deps.host.document.visibilityState === 'visible'

  running: Running | undefined

  lastCheck = -Infinity

  lastInput = -Infinity

  sinceCheck = () => tick() - this.lastCheck

  context = (source: ChangeSource): Context => ({
    now: Date.now(),
    gateOpen: this.visible() && tick() - this.lastInput >= this.deps.idleMs,
    source,
  })

  evaluate = (
    source: ChangeSource,
    latest: VersionInfo | undefined = this.deps.machine.getState().latest,
  ) => {
    this.deps.machine.apply(latest, this.context(source))
    this.reschedule()
  }

  reschedule = () => {
    if (!this.running) {
      return
    }

    clearTimeout(this.running.wake)
    this.running.wake = undefined

    if (!this.visible()) {
      return
    } // hidden: no timer; visibilitychange brings us back

    const ctx = this.context('time')
    const { deadlines, held } = this.deps.machine.pending(ctx)
    const t = tick()

    const delays = [
      this.lastCheck + this.deps.pollMs - t,
      ...deadlines.map(d => d - ctx.now),
      ...(held ? [this.lastInput + this.deps.idleMs - t] : []),
    ]

    const delay = Math.min(Math.max(0, Math.min(...delays)), MAX_TIMER_MS)
    this.running.wake = setTimeout(this.onWake, delay)
  }

  onWake = () => {
    this.evaluate('time') // thresholds and snooze expiry don't depend on the network

    if (this.sinceCheck() >= this.deps.pollMs) {
      void this.check()
    }
  }

  check = async () => {
    if (!this.running || !this.visible()) {
      return
    }

    this.running.inFlight?.abort() // newest check wins; a stale response can never land
    const controller = new AbortController()
    this.running.inFlight = controller
    this.lastCheck = tick()
    this.reschedule() // the next poll counts from now, whatever triggered this check

    const timeout = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )

    try {
      const res = await this.deps.host.fetch(
        `${this.deps.url}?t=${Date.now()}`,
        {
          cache: 'no-store',
          signal: controller.signal,
        },
      )

      const result = await readResponse(res, controller.signal)

      if (!result) {
        return
      }

      this.deps.machine.observeServerTime(result.serverTime, tick())
      this.evaluate('check', result.latest)
    } catch {
      /* aborted, timed out, offline or mid-deploy: the timer still evaluates */
    } finally {
      clearTimeout(timeout)

      if (this.running?.inFlight === controller) {
        this.running.inFlight = undefined
      }
    }
  }

  markInput = () => {
    this.lastInput = tick()
  }

  listen = (
    target: EventTarget,
    [type, opts]: readonly [string, AddEventListenerOptions?],
    fn: EventListener,
  ) => {
    target.addEventListener(type, fn, opts)
    this.running?.cleanups.push(() =>
      target.removeEventListener(type, fn, opts),
    )
  }

  listenInputs = () => {
    this.listen(
      this.deps.host.window,
      ['keydown', { capture: true, passive: true }],
      this.markInput,
    )
    this.listen(
      this.deps.host.window,
      ['pointerdown', { capture: true, passive: true }],
      this.markInput,
    )
    this.listen(this.deps.host.window, ['storage'], e => {
      const change = readStorageChange(e, this.deps.host)

      if (change && this.deps.snoozes.onStorage(change)) {
        this.evaluate('other-tab')
      }
    })
  }

  start = () => {
    this.running = { cleanups: [] }
    this.deps.snoozes.hydrate()
    this.listen(this.deps.host.document, ['visibilitychange'], () => {
      this.evaluate('time') // releases a held raise when visible; clears the timer when hidden

      if (this.visible() && this.sinceCheck() >= MIN) {
        void this.check()
      }
    })
    this.listen(this.deps.host.window, ['focus'], () => {
      if (this.sinceCheck() >= MIN) {
        void this.check()
      }
    })
    this.listenInputs()

    if (this.deps.reloadOnChunkError) {
      this.listen(
        this.deps.host.window,
        ['vite:preloadError'],
        this.deps.reloads.onChunkError,
      )
    }

    const navigate = this.deps.subscribeToNavigation

    if (navigate) {
      this.running.cleanups.push(
        navigate(to => {
          if (!this.deps.machine.isBehind()) {
            return
          }

          void this.deps.reloads.request({
            reason: 'navigate',
            href: to?.href ?? this.deps.host.location.href,
          })
        }),
      )
    }

    // Time passed while unsubscribed: release what was held on what we already know,
    // rather than waiting for the check to land (or a whole poll if it fails).
    this.evaluate('time')
    void this.check() // no-op while hidden; visibilitychange triggers the first check
  }

  stop = () => {
    if (!this.running) {
      return
    }

    const { cleanups, inFlight, wake } = this.running
    this.running = undefined
    clearTimeout(wake)
    inFlight?.abort()
    cleanups.forEach(cleanup => cleanup())
  }
}

export function createEngine(deps: EngineDeps) {
  return new Engine(deps)
}
