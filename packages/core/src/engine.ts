import type { Host, StorageChange } from './host'
import * as v from 'valibot'
import { isVersionInfo } from './policy'
import type { createMachine } from './machine'
import type { createSnoozes } from './snoozes'
import type { VersionInfo } from './types'

const MIN = 60_000
const FETCH_TIMEOUT_MS = 30_000
const MAX_TIMER_MS = 2 ** 31 - 1

export interface EngineDeps {
  url: string
  pollMs: number
  machine: ReturnType<typeof createMachine>
  snoozes: ReturnType<typeof createSnoozes>
  host: Host
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
    return undefined
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

  sinceCheck = () => tick() - this.lastCheck

  evaluate = (latest?: VersionInfo) => {
    this.deps.machine.apply(latest)
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

    const deadline = this.deps.machine.nextAt
    const delays = [this.lastCheck + this.deps.pollMs - tick()]

    if (deadline !== undefined) {
      delays.push(deadline - Date.now())
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
    this.listen(this.deps.host.window, 'storage', e => {
      const change = readStorageChange(e, this.deps.host)

      if (change && this.deps.snoozes.onStorage(change)) {
        this.evaluate()
      }
    })
  }

  start = () => {
    this.running = { cleanups: [] }
    this.deps.snoozes.hydrate()
    this.listen(this.deps.host.document, 'visibilitychange', () => {
      this.evaluate()

      if (this.visible() && this.sinceCheck() >= MIN) {
        void this.check()
      }
    })
    this.listen(this.deps.host.window, 'focus', () => {
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

export function createEngine(deps: EngineDeps) {
  return new Engine(deps)
}
