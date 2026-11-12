import type { Environment, StorageChange } from '../src/environment'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

async function turns(count: number) {
  for (let i = 0; i < count; i++) {
    await turn()
  }
}

class MemoryStorage {
  readonly #items = new Map<string, string>()
  getItem(key: string) {
    return this.#items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.#items.set(key, value)
  }
  removeItem(key: string) {
    this.#items.delete(key)
  }
  clear() {
    this.#items.clear()
  }
}

function listeners<T extends unknown[]>() {
  const all = new Set<(...args: T) => void>()

  return {
    add: (listener: (...args: T) => void) => {
      all.add(listener)

      return () => void all.delete(listener)
    },
    emit: (...args: T) =>
      Array.from(all).forEach(listener => listener(...args)),
  }
}

/** Counts a response as pending until its body has been read, so tests can wait for it. */
function trackResponses(inner: () => typeof fetch) {
  const pending = new Set<symbol>()

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const token = Symbol()
    const signal = init?.signal

    const finish = () => {
      pending.delete(token)
      signal?.removeEventListener('abort', finish)
    }

    pending.add(token)
    signal?.addEventListener('abort', finish, { once: true })

    try {
      const response = await inner()(input, init)

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

  return { fetch, pending }
}

export interface FakeEnvironmentOptions {
  start?: string
  fetch?: typeof fetch
}

/**
 * A browser tab with virtual time. The clock moves only when a test advances
 * it, and timers run in order as it passes them. The network stays real, so
 * MSW works without special handling.
 */
export function createFakeEnvironment(options: FakeEnvironmentOptions = {}) {
  let wall = Date.parse(options.start ?? '2026-11-11T16:00:00Z')
  let monotonic = 0
  let visible = true
  let reloads = 0
  let lastTimer = 0
  const timers = new Map<number, { due: number; callback: () => void }>()

  const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> =
    new MemoryStorage()

  const visibility = listeners<[]>()
  const focus = listeners<[]>()
  const storageChanges = listeners<[StorageChange]>()
  const responses = trackResponses(() => options.fetch ?? globalThis.fetch)

  const env: Environment = {
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    startTimer(callback, ms) {
      const id = ++lastTimer
      timers.set(id, { due: monotonic + ms, callback })

      return () => void timers.delete(id)
    },
    fetch: responses.fetch,
    storage,
    baseUrl: () => 'https://app.test/now',
    isVisible: () => visible,
    onVisibilityChange: visibility.add,
    onFocus: focus.add,
    onStorageChange: storageChanges.add,
    reload: () => void reloads++,
  }

  const moveTo = (time: number) => {
    wall += time - monotonic
    monotonic = time
  }

  function nextTimer(until: number) {
    let next: [number, { due: number; callback: () => void }] | undefined

    for (const entry of timers) {
      if (entry[1].due <= until && (!next || entry[1].due < next[1].due)) {
        next = entry
      }
    }

    return next
  }

  /** Move virtual time forward, running each timer as the clock reaches it. */
  async function advance(ms: number) {
    const end = monotonic + ms

    for (let next = nextTimer(end); next; next = nextTimer(end)) {
      const [id, timer] = next
      timers.delete(id)
      moveTo(Math.max(monotonic, timer.due))
      timer.callback()
      await turns(2)
    }

    moveTo(end)
  }

  async function flush() {
    await advance(0)
    await turns(3)
  }

  async function waitForResponse() {
    const deadline = Date.now() + 1_000
    await flush()

    while (responses.pending.size > 0) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${responses.pending.size} response(s) to finish`,
        )
      }

      await new Promise<void>(resolve => setTimeout(resolve, 1))
      await flush()
    }
  }

  /** Like `advance`, but also waits for the network after each timer. */
  async function runFor(ms: number) {
    const end = monotonic + ms

    for (;;) {
      const due = Math.min(...Array.from(timers.values(), timer => timer.due))
      await advance(Math.max(0, Math.min(due, end) - monotonic))
      await waitForResponse()

      if (monotonic >= end) {
        return
      }
    }
  }

  return {
    env,
    storage,
    now: () => wall,
    setSystemTime(time: string | number) {
      wall = new Date(time).getTime()
    },
    advance,
    flush,
    waitForResponse,
    runFor,
    pendingTimers: () => timers.size,
    get reloads() {
      return reloads
    },
    focus: () => focus.emit(),
    setVisibility(state: 'visible' | 'hidden') {
      visible = state === 'visible'
      visibility.emit()
    },
    setVisibilitySilently(state: 'visible' | 'hidden') {
      visible = state === 'visible'
    },
    otherTabSets(key: string, value: string) {
      storage.setItem(key, value)
      storageChanges.emit({ key, newValue: value })
    },
    otherTabClears() {
      storage.clear()
      storageChanges.emit({ key: null, newValue: null })
    },
  }
}

export type FakeEnvironment = ReturnType<typeof createFakeEnvironment>
