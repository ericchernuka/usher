import * as v from 'valibot'
import type { Environment, StorageChange } from './environment'

const StoredDismissal = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({
    dismissedAt: v.fallback(
      v.optional(v.pipe(v.number(), v.finite())),
      undefined,
    ),
  }),
)

function parse(raw: string | null): number | undefined {
  const result = v.safeParse(StoredDismissal, raw)

  return result.success ? result.output.dismissedAt : undefined
}

const later = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

/**
 * The server time of the latest prompt dismissal, shared by every tab of the app
 * through storage. The latest dismissal wins. When storage is blocked, the
 * dismissal still holds in this tab.
 *
 * The stored record is `{ "dismissedAt": <server time in ms> }` under
 * `<storageKey>:prompt-dismissal`. Other tabs and older releases read it, so
 * treat the format as a contract.
 */
export function createPromptDismissal(
  storageKey: string,
  env: Pick<Environment, 'storage' | 'onStorageChange'>,
) {
  const key = `${storageKey}:prompt-dismissal`
  let dismissedAt: number | undefined
  let unsynced = false
  let stopListening: (() => void) | undefined

  function hydrate() {
    try {
      const stored = parse(env.storage.getItem(key))
      dismissedAt = unsynced ? later(dismissedAt, stored) : stored
    } catch {}
  }

  function onStorage(change: StorageChange, onChange: () => void) {
    if (change.key !== null && change.key !== key) {
      return
    }

    dismissedAt =
      change.key === null || change.newValue === null
        ? undefined
        : later(dismissedAt, parse(change.newValue))

    onChange()
  }

  return {
    get: (): number | undefined => dismissedAt,

    /** Read what other tabs left in storage and follow their changes. */
    start(onChange: () => void) {
      hydrate()
      stopListening = env.onStorageChange(change => onStorage(change, onChange))
    },

    stop() {
      stopListening?.()
      stopListening = undefined
    },

    record(at: number) {
      dismissedAt = at

      try {
        env.storage.setItem(key, JSON.stringify({ dismissedAt }))
        unsynced = false
      } catch {
        unsynced = true
      }
    },
  }
}
