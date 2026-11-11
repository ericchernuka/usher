// Internal. The DOM side: lifecycle, inputs, the one timer, and fetching version.json.
//
// Every input calls the machine and then `reschedule()`, which derives the single wake-up
// from deadlines: next poll, the policy's own deadlines (thresholds, snooze expiry), and
// idle release while a raise is held. Every wake re-evaluates first, so time-based changes
// happen even when fetches fail. Hidden tabs have no wake timer (an in-flight fetch keeps
// its own timeout until it settles).
import type { Host, StorageChange } from './host'
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
  if (!res.ok) return undefined
  const body: unknown = await res.json()
  if (signal.aborted) return undefined
  if (!isVersionInfo(body))
    return void console.warn(
      '[app-version] ignoring malformed version.json',
      body,
    )
  // Cross-origin responses need `Access-Control-Expose-Headers: Date` for this; else no correction.
  const serverDate = Date.parse(res.headers.get('date') ?? '')
  return {
    latest: body,
    serverTime: Number.isNaN(serverDate) ? undefined : serverDate,
  }
}

export function createEngine(deps: EngineDeps) {
  const { machine, host } = deps
  const visible = () => host.document.visibilityState === 'visible'
  let running: Running | undefined
  let lastCheck = -Infinity
  let lastInput = -Infinity

  const sinceCheck = () => tick() - lastCheck
  const context = (source: ChangeSource): Context => ({
    now: Date.now(),
    gateOpen: visible() && tick() - lastInput >= deps.idleMs,
    source,
  })

  /** Feed facts to the machine, then recompute the timer. The one path for every input. */
  function evaluate(
    source: ChangeSource,
    latest: VersionInfo | undefined = machine.getState().latest,
  ) {
    machine.apply(latest, context(source))
    reschedule()
  }

  function reschedule() {
    if (!running) return
    clearTimeout(running.wake)
    running.wake = undefined
    if (!visible()) return // hidden: no timer; visibilitychange brings us back

    const ctx = context('time')
    const { deadlines, held } = machine.pending(ctx)
    const t = tick()
    const delays = [
      lastCheck + deps.pollMs - t,
      ...deadlines.map(d => d - ctx.now),
      ...(held ? [lastInput + deps.idleMs - t] : []),
    ]
    const delay = Math.min(Math.max(0, Math.min(...delays)), MAX_TIMER_MS)
    running.wake = setTimeout(onWake, delay)
  }

  function onWake() {
    evaluate('time') // thresholds and snooze expiry don't depend on the network
    if (sinceCheck() >= deps.pollMs) void check()
  }

  async function check() {
    if (!running || !visible()) return
    running.inFlight?.abort() // newest check wins; a stale response can never land
    const controller = new AbortController()
    running.inFlight = controller
    lastCheck = tick()
    reschedule() // the next poll counts from now, whatever triggered this check
    const timeout = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )
    try {
      const res = await host.fetch(`${deps.url}?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const result = await readResponse(res, controller.signal)
      if (!result) return
      machine.observeServerTime(result.serverTime, tick())
      evaluate('check', result.latest)
    } catch {
      /* aborted, timed out, offline or mid-deploy: the timer still evaluates */
    } finally {
      clearTimeout(timeout)
      if (running?.inFlight === controller) running.inFlight = undefined
    }
  }

  /** Record input time only; the timer re-checks idleness, so there's no work per keystroke. */
  function markInput() {
    lastInput = tick()
  }

  function listen(
    target: EventTarget,
    type: string,
    fn: EventListener,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, fn, opts)
    running?.cleanups.push(() => target.removeEventListener(type, fn, opts))
  }

  function start() {
    running = { cleanups: [] }
    deps.snoozes.hydrate()
    listen(host.document, 'visibilitychange', () => {
      evaluate('time') // releases a held raise when visible; clears the timer when hidden
      if (visible() && sinceCheck() >= MIN) void check()
    })
    listen(host.window, 'focus', () => {
      if (sinceCheck() >= MIN) void check()
    })
    listen(host.window, 'keydown', markInput, { capture: true, passive: true })
    listen(host.window, 'pointerdown', markInput, { capture: true, passive: true })
    listen(host.window, 'storage', e => {
      // SAFETY: the browser dispatches a StorageEvent for 'storage', which has these fields.
      const change = e as Event & StorageChange
      if (deps.snoozes.onStorage(change)) evaluate('other-tab')
    })
    if (deps.reloadOnChunkError)
      listen(host.window, 'vite:preloadError', deps.reloads.onChunkError)
    const navigate = deps.subscribeToNavigation
    if (navigate) {
      running.cleanups.push(
        navigate(to => {
          if (!machine.isBehind()) return
          void deps.reloads.request({
            reason: 'navigate',
            href: to?.href ?? host.location.href,
          })
        }),
      )
    }
    // Time passed while unsubscribed: release what was held on what we already know,
    // rather than waiting for the check to land (or a whole poll if it fails).
    evaluate('time')
    void check() // no-op while hidden; visibilitychange triggers the first check
  }

  function stop() {
    if (!running) return
    const { cleanups, inFlight, wake } = running
    running = undefined
    clearTimeout(wake)
    inFlight?.abort()
    cleanups.forEach(cleanup => cleanup())
  }

  return {
    start,
    stop,
    context,
    reschedule,
  }
}
