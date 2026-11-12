import { vi } from 'vitest'
import { server } from './mocks/node'

const SRC = new URL('../src/', import.meta.url).pathname
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

/** A request that is never answered (or aborted) must not stall a settle forever. */
const MAX_NETWORK_TURNS = 50

/**
 * Fake time for a test file: timers, `Date` and `performance`, never the microtask
 * queue (MSW and Node's streams need it). Returns:
 * - `settle()`: let the work started so far finish, without moving time.
 * - `runFor(ms)`: move time forward, firing due timers on the way (Playwright's `clock.runFor`).
 * - `setSystemTime(time)`: move the page's `Date` without firing timers (Playwright's `clock.setSystemTime`).
 * - `pendingStoreTimers()`: how many timers the store itself has pending.
 * Only timers set by `src/` run on fake time.
 */
export interface Clock {
  settle: () => Promise<void>
  runFor: (ms: number) => Promise<void>
  setSystemTime: (time: string | number | Date) => void
  pendingStoreTimers: () => number
  dispose: () => void
}

const FAKED = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
] as const

/** Plain fake time, for stores whose `fetch` is in memory: there are no other timers to tell apart. */
export function installPlainClock(start = '2026-11-11T16:00:00Z'): Clock {
  vi.useFakeTimers({ toFake: [...FAKED] })
  vi.setSystemTime(new Date(start))

  return {
    settle: async () => {
      await vi.advanceTimersByTimeAsync(0)
    },
    runFor: async ms => {
      await vi.advanceTimersByTimeAsync(ms)
    },
    setSystemTime: time => vi.setSystemTime(time),
    pendingStoreTimers: () => vi.getTimerCount(),
    dispose() {
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
}

/** Fake time alongside MSW: the store's timers are fake, the HTTP client's are real. */
export function installClock(start = '2026-11-11T16:00:00Z'): Clock {
  const pending = new Map<unknown, number>() // store timer -> due, on the performance clock
  const real = new Set<unknown>()
  const inFlight = new Set<Request>()
  server.events.on('request:start', ({ request }) => void inFlight.add(request))
  server.events.on(
    'request:end',
    ({ request }) => void inFlight.delete(request),
  )
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  {
    vi.useFakeTimers({ toFake: [...FAKED] })
    vi.setSystemTime(new Date(start))
    const set = globalThis.setTimeout
    const clear = globalThis.clearTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (
        callback: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        if (!new Error().stack?.includes(SRC)) {
          // Not the store's: the HTTP client's own timers keep real time, or they would
          // tick thousands of times across a simulated day.
          const id = realSet(callback, ms, ...args)
          real.add(id)

          return id
        }

        const id = set(
          (...fired: unknown[]) => {
            pending.delete(id)
            callback(...fired)
          },
          ms,
          ...args,
        )

        pending.set(id, performance.now() + (ms ?? 0))

        return id
      },
    )
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(id => {
      if (real.delete(id)) {
        return realClear(id)
      }

      pending.delete(id)
      clear(id)
    })
  }

  /** Let in-flight (mocked) requests finish. They need real turns that fake time never gives. */
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(0)

    for (let turn = 0; turn < MAX_NETWORK_TURNS; turn++) {
      await nextTurn() // lets MSW start, answer and finish whatever is in flight

      if (inFlight.size === 0 && turn >= 2) {
        break
      }
    }

    await vi.advanceTimersByTimeAsync(0)
  }

  /**
   * Move time forward, stopping at each of the store's own timers to let its request
   * finish, as a real network would between a poll and the next one.
   */
  const runFor = async (ms: number) => {
    const end = performance.now() + ms

    for (;;) {
      const due = Math.min(...pending.values())
      const step = Math.max(0, Math.min(due, end) - performance.now())
      await vi.advanceTimersByTimeAsync(step)
      await settle()

      if (performance.now() >= end) {
        return
      }
    }
  }

  return {
    settle,
    runFor,
    setSystemTime: time => vi.setSystemTime(time),
    pendingStoreTimers: () => pending.size,
    dispose() {
      pending.clear()
      real.clear()
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
}
