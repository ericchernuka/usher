import * as v from 'valibot'
import type { BrowserEnvironment, StorageChange } from './browser'

export interface PromptDismissal {
  promptAt?: number
}

const Finite = v.pipe(v.number(), v.finite())

const lenient = <const T extends v.GenericSchema>(schema: T) =>
  v.fallback(v.optional(schema), undefined)

const StoredDismissal = v.pipe(
  v.object({
    promptAt: lenient(Finite),
  }),
  v.transform(({ promptAt }): PromptDismissal => ({
    ...(promptAt !== undefined && { promptAt }),
  })),
)

const StoredDismissalJson = v.pipe(v.string(), v.parseJson(), StoredDismissal)

function parse(raw: string): PromptDismissal | undefined {
  const result = v.safeParse(StoredDismissalJson, raw)

  return result.success ? result.output : undefined
}

const max = (x?: number, y?: number) =>
  x === undefined ? y : y === undefined ? x : Math.max(x, y)

function later(a: PromptDismissal, b: PromptDismissal): PromptDismissal {
  const promptAt = max(a.promptAt, b.promptAt)

  return promptAt === undefined ? {} : { promptAt }
}

function isOurArea(e: StorageChange, browser: BrowserEnvironment) {
  try {
    return e.storageArea === browser.localStorage
  } catch {
    return false
  }
}

export function createPromptDismissal(
  storageKey: string,
  browser: BrowserEnvironment,
) {
  const key = `${storageKey}:snooze`
  let memory: PromptDismissal = {}
  let unsynced = false

  return {
    get: (): PromptDismissal => memory,

    hydrate() {
      try {
        const raw = browser.localStorage.getItem(key)
        const stored = (raw === null ? undefined : parse(raw)) ?? {}
        memory = unsynced ? later(memory, stored) : stored
      } catch {}
    },

    onStorage(e: StorageChange): boolean {
      if (!isOurArea(e, browser)) {
        return false
      }

      if (e.key === null || (e.key === key && e.newValue === null)) {
        memory = {}

        return true
      }

      if (e.key !== key || e.newValue === null) {
        return false
      }

      const incoming = parse(e.newValue)

      if (incoming) {
        memory = later(memory, incoming)
      }

      return true
    },

    write(next: PromptDismissal) {
      memory = next

      try {
        browser.localStorage.setItem(key, JSON.stringify(memory))
        unsynced = false
      } catch {
        unsynced = true
      }
    },
  }
}
