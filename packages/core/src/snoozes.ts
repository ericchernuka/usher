import * as v from 'valibot'
import type { Host, StorageChange } from './host'
import type { Snoozes } from './policy'

const Finite = v.pipe(v.number(), v.finite())

const lenient = <const T extends v.GenericSchema>(schema: T) =>
  v.fallback(v.optional(schema), undefined)

const StoredSnoozes = v.pipe(
  v.object({
    promptAt: lenient(Finite),
  }),
  v.transform(({ promptAt }): Snoozes => ({
    ...(promptAt !== undefined && { promptAt }),
  })),
)

const StoredSnoozesJson = v.pipe(v.string(), v.parseJson(), StoredSnoozes)

function parse(raw: string): Snoozes | undefined {
  const result = v.safeParse(StoredSnoozesJson, raw)

  return result.success ? result.output : undefined
}

const max = (x?: number, y?: number) =>
  x === undefined ? y : y === undefined ? x : Math.max(x, y)

function later(a: Snoozes, b: Snoozes): Snoozes {
  const promptAt = max(a.promptAt, b.promptAt)

  return promptAt === undefined ? {} : { promptAt }
}

function isOurArea(e: StorageChange, host: Host) {
  try {
    return e.storageArea === host.localStorage
  } catch {
    return false
  }
}

export function createSnoozes(storageKey: string, host: Host) {
  const key = `${storageKey}:snooze`
  let memory: Snoozes = {}
  let unsynced = false

  return {
    get: (): Snoozes => memory,

    hydrate() {
      try {
        const raw = host.localStorage.getItem(key)
        const stored = (raw === null ? undefined : parse(raw)) ?? {}
        memory = unsynced ? later(memory, stored) : stored
      } catch {}
    },

    onStorage(e: StorageChange): boolean {
      if (!isOurArea(e, host)) {
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

    write(next: Snoozes) {
      memory = next

      try {
        host.localStorage.setItem(key, JSON.stringify(memory))
        unsynced = false
      } catch {
        unsynced = true
      }
    },
  }
}
