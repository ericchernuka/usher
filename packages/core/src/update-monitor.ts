import type { BrowserEnvironment, StorageChange } from './browser'
import * as v from 'valibot'
import { isVersionInfo } from './attention'
import type { createPromptDismissal } from './prompt-dismissal'
import type { VersionInfo } from './types'

const MIN = 60_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1
const CLOCK_JITTER_MS = 2_000

export interface UpdateMonitorOptions {
  url: string
  pollMs: number
  evaluate: (latest?: VersionInfo) => void
  nextDeadline: () => number | undefined
  dismissal: ReturnType<typeof createPromptDismissal>
  browser: BrowserEnvironment
}

type Running = {
  cleanups: Array<() => void>
  inFlight?: AbortController | undefined
  wake?: ReturnType<typeof setTimeout> | undefined
}

const tick = () => performance.now()

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
  browser: BrowserEnvironment,
): StorageChange | undefined {
  try {
    const storageArea = browser.localStorage

    if (!('storageArea' in event) || event.storageArea !== storageArea) {
      return undefined
    }

    const parsed = v.safeParse(StorageFields, event)

    return parsed.success ? { ...parsed.output, storageArea } : undefined
  } catch {
    return undefined
  }
}

class UpdateMonitor {
  readonly deps: UpdateMonitorOptions

  constructor(deps: UpdateMonitorOptions) {
    this.deps = deps
  }
  visible = () => this.deps.browser.document.visibilityState === 'visible'

  running: Running | undefined

  lastCheck = -Infinity
  serverMinusTick: number | undefined

  serverNow = () =>
    this.serverMinusTick === undefined
      ? Date.now()
      : this.serverMinusTick + tick()

  observeServerTime = (serverTime: number | undefined) => {
    if (serverTime === undefined) {
      return
    }

    const next = serverTime - tick()

    if (
      this.serverMinusTick === undefined ||
      Math.abs(next - this.serverMinusTick) >= CLOCK_JITTER_MS
    ) {
      this.serverMinusTick = next
    }
  }

  sinceCheck = () => tick() - this.lastCheck

  evaluate = (latest?: VersionInfo) => {
    this.deps.evaluate(latest)
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
    }

    const deadline = this.deps.nextDeadline()
    const delays = [this.lastCheck + this.deps.pollMs - tick()]

    if (deadline !== undefined) {
      delays.push(deadline - this.serverNow())
    }

    const delay = Math.min(Math.max(0, Math.min(...delays)), MAX_TIMER_MS)
    this.running.wake = setTimeout(this.onWake, delay)
  }

  onWake = () => {
    this.evaluate()

    if (this.sinceCheck() >= this.deps.pollMs) {
      void this.check()
    }
  }

  check = async () => {
    if (!this.running || !this.visible()) {
      return
    }

    this.running.inFlight?.abort()
    const controller = new AbortController()
    this.running.inFlight = controller
    this.lastCheck = tick()
    this.reschedule()

    const timeout = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    )

    try {
      const res = await this.deps.browser.fetch(
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

      this.observeServerTime(result.serverTime)
      this.evaluate(result.latest)
    } catch {
    } finally {
      clearTimeout(timeout)

      if (this.running?.inFlight === controller) {
        this.running.inFlight = undefined
      }
    }
  }

  listen = (target: EventTarget, type: string, fn: EventListener) => {
    target.addEventListener(type, fn)
    this.running?.cleanups.push(() => target.removeEventListener(type, fn))
  }

  listenStorage = () => {
    this.listen(this.deps.browser.window, 'storage', e => {
      const change = readStorageChange(e, this.deps.browser)

      if (change && this.deps.dismissal.onStorage(change)) {
        this.evaluate()
      }
    })
  }

  start = () => {
    this.running = { cleanups: [] }
    this.deps.dismissal.hydrate()
    this.listen(this.deps.browser.document, 'visibilitychange', () => {
      this.evaluate()

      if (this.visible() && this.sinceCheck() >= MIN) {
        void this.check()
      }
    })
    this.listen(this.deps.browser.window, 'focus', () => {
      if (this.sinceCheck() >= MIN) {
        void this.check()
      }
    })
    this.listenStorage()

    this.evaluate()
    void this.check()
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

export function createUpdateMonitor(options: UpdateMonitorOptions) {
  return new UpdateMonitor(options)
}
