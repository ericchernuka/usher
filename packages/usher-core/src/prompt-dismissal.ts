import * as valibot from 'valibot'
import type { StorageChange } from './environment'
import { resolvePromptDismissal, type PromptDismissalOptions } from './options'
import { createListeners, type Readable } from './readable'
import { insideTab, type Tab } from './tab'

const StoredDismissal = valibot.pipe(
  valibot.string(),
  valibot.parseJson(),
  valibot.object({
    dismissedAt: valibot.pipe(valibot.number(), valibot.finite()),
  }),
)

function parse(raw: string | null): number | undefined {
  const result = valibot.safeParse(StoredDismissal, raw)

  return result.success ? result.output.dismissedAt : undefined
}

const later = (first: number | undefined, second: number | undefined) =>
  first === undefined
    ? second
    : second === undefined
      ? first
      : Math.max(first, second)

export interface PromptDismissal extends Readable<number | undefined> {
  record: (at: number) => void
  /**
   * End of the quiet that a dismissal at `dismissedAt` gives a prompt
   * dismissable from `dismissableFrom`, `Infinity` without a snooze, or
   * `undefined` when that dismissal does not quiet it
   */
  quietUntil: (
    dismissableFrom: number | undefined,
    dismissedAt: number | undefined,
  ) => number | undefined
}

export function createPromptDismissal(
  tab: Tab,
  options: PromptDismissalOptions = {},
): PromptDismissal {
  const { storageKey, promptSnooze } = resolvePromptDismissal(options)
  const { env } = insideTab(tab)
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

  function onStorage(change: StorageChange) {
    if (change.key !== null && change.key !== key) {
      return
    }

    dismissedAt =
      change.key === null || change.newValue === null
        ? undefined
        : later(dismissedAt, parse(change.newValue))

    listeners.notify()
  }

  const listeners = createListeners({
    start() {
      hydrate()
      stopListening = env.onStorageChange(onStorage)
    },
    stop() {
      stopListening?.()
      stopListening = undefined
    },
  })

  return {
    get: () => dismissedAt,
    subscribe: listeners.subscribe,
    quietUntil(dismissableFrom, at) {
      if (
        dismissableFrom === undefined ||
        at === undefined ||
        at < dismissableFrom
      ) {
        return undefined
      }

      return promptSnooze === undefined ? Infinity : at + promptSnooze
    },
    record(at) {
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
