// Internal. Dismissals ("snoozes"), shared across tabs. Times are server-clock (see policy.ts).
//
// Memory is this tab's working copy; localStorage is the channel between tabs. On start,
// readable storage wins (so a clear while we weren't listening still un-snoozes), unless
// our last write failed, in which case memory holds something storage never got.
import * as v from 'valibot'
import type { Host, StorageChange } from './host'
import type { Snoozes } from './policy'

const Finite = v.pipe(v.number(), v.finite())

const BadSnoozeSchema = v.object({
  evidence: v.array(v.string()),
  until: Finite,
})

/** Per-build acknowledgements: entries that don't parse are dropped, and none left means no record. */
const StoredBad = v.pipe(
  v.record(v.string(), v.unknown()),
  v.transform(entries =>
    Object.fromEntries(
      Object.entries(entries).flatMap(([version, entry]) => {
        const parsed = v.safeParse(BadSnoozeSchema, entry)

        return parsed.success ? [[version, parsed.output]] : []
      }),
    ),
  ),
  v.transform(valid => (Object.keys(valid).length ? valid : undefined)),
)

/** A field of the stored record that's unreadable counts as absent; the others still apply. */
const lenient = <const T extends v.GenericSchema>(schema: T) =>
  v.fallback(v.optional(schema), undefined)

/** What another tab or an older version may have left in storage, read field by field. */
const StoredSnoozes = v.pipe(
  v.object({
    promptAt: lenient(Finite),
    urgentAt: lenient(Finite),
    bad: lenient(StoredBad),
  }),
  v.transform(({ promptAt, urgentAt, bad }): Snoozes => ({
    ...(promptAt !== undefined && { promptAt }),
    ...(urgentAt !== undefined && { urgentAt }),
    ...(bad && { bad }),
  })),
)

const StoredSnoozesJson = v.pipe(v.string(), v.parseJson(), StoredSnoozes)

function parse(raw: string): Snoozes | undefined {
  const result = v.safeParse(StoredSnoozesJson, raw)
  return result.success ? result.output : undefined
}

const max = (x?: number, y?: number) =>
  x === undefined ? y : y === undefined ? x : Math.max(x, y)

/** Dismissals only ever move later (covering more), so merging by the later time is safe. */
function later(a: Snoozes, b: Snoozes): Snoozes {
  const promptAt = max(a.promptAt, b.promptAt)
  const urgentAt = max(a.urgentAt, b.urgentAt)
  const bad = { ...a.bad }
  for (const [version, entry] of Object.entries(b.bad ?? {})) {
    if (!bad[version] || entry.until > bad[version].until) bad[version] = entry
  }
  return {
    ...(promptAt !== undefined && { promptAt }),
    ...(urgentAt !== undefined && { urgentAt }),
    ...(Object.keys(bad).length && { bad }),
  }
}

/** Drop expired known-bad entries; prompt/urgent records are single numbers and stay. */
function prune(s: Snoozes, serverNow: number): Snoozes {
  const bad = Object.fromEntries(
    Object.entries(s.bad ?? {}).filter(([, e]) => e.until > serverNow),
  )
  const { bad: _expired, ...rest } = s
  return Object.keys(bad).length ? { ...rest, bad } : rest
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
  let unsynced = false // our last write didn't reach storage

  return {
    get: (): Snoozes => memory,

    /** Catch up with what other tabs did while we weren't listening. */
    hydrate() {
      try {
        const raw = host.localStorage.getItem(key)
        const stored = (raw === null ? undefined : parse(raw)) ?? {}
        memory = unsynced ? later(memory, stored) : stored
      } catch {
        /* storage blocked: memory only */
      }
    },

    /** Apply another tab's change. Returns true if it concerned us. */
    onStorage(e: StorageChange): boolean {
      if (!isOurArea(e, host)) return false
      if (e.key === null || (e.key === key && e.newValue === null)) {
        memory = {} // storage cleared or our key removed: un-snooze
        return true
      }
      if (e.key !== key || e.newValue === null) return false
      const incoming = parse(e.newValue)
      if (incoming) memory = later(memory, incoming)
      return true
    },

    write(next: Snoozes, serverNow: number) {
      memory = prune(next, serverNow)
      try {
        host.localStorage.setItem(key, JSON.stringify(memory))
        unsynced = false
      } catch {
        unsynced = true /* blocked or full: the snooze still holds in this tab */
      }
    },
  }
}
