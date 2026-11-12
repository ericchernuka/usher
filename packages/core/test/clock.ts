import { vi } from 'vitest'

const SRC = new URL('../src/', import.meta.url).pathname
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

export interface Clock {
  flush: () => Promise<void>
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

export function installPlainClock(start = '2026-11-11T16:00:00Z'): Clock {
  vi.useFakeTimers({ toFake: [...FAKED] })
  vi.setSystemTime(new Date(start))

  return {
    flush: async () => {
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

function trackResponses() {
  const pending = new Set<symbol>()

  const trackedFetch: typeof fetch = async (input, init) => {
    const token = Symbol()
    const signal = init?.signal

    const finish = () => {
      pending.delete(token)
      signal?.removeEventListener('abort', finish)
    }

    pending.add(token)
    signal?.addEventListener('abort', finish, { once: true })

    try {
      const response = await globalThis.fetch(input, init)

      if (response.ok) {
        const json = response.json.bind(response)
        response.json = () => json().finally(finish)
      } else {
        finish()
      }

      return response
    } catch (error) {
      finish()

      throw error
    }
  }

  return { fetch: trackedFetch, pending }
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)

  for (let turn = 0; turn < 3; turn++) {
    await nextTurn()
  }

  await vi.advanceTimersByTimeAsync(0)
}

export function installClock(start = '2026-11-11T16:00:00Z') {
  const pending = new Map<unknown, number>()
  const real = new Set<unknown>()
  const responses = trackResponses()
  const realNow = Date.now
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

  const waitForResponse = async () => {
    const deadline = realNow() + 1_000
    await flush()

    while (responses.pending.size > 0) {
      if (realNow() >= deadline) {
        throw new Error(
          `Timed out waiting for ${responses.pending.size} response(s) to finish`,
        )
      }

      await new Promise<void>(resolve => realSet(resolve, 1))
      await flush()
    }
  }

  const runFor = async (ms: number) => {
    const end = performance.now() + ms

    for (;;) {
      const due = Math.min(...pending.values())
      const step = Math.max(0, Math.min(due, end) - performance.now())
      await vi.advanceTimersByTimeAsync(step)
      await waitForResponse()

      if (performance.now() >= end) {
        return
      }
    }
  }

  return {
    flush,
    waitForResponse,
    fetch: responses.fetch,
    runFor,
    setSystemTime: (time: string | number | Date) => vi.setSystemTime(time),
    pendingStoreTimers: () => pending.size,
    dispose() {
      pending.clear()
      real.clear()
      vi.restoreAllMocks()
      vi.useRealTimers()
    },
  }
}
