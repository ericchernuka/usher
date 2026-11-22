/** One fact an app can read and subscribe to */
export interface Readable<Value> {
  /** Current value, the same object until it changes */
  get: () => Value
  /**
   * Listener registration that returns its own removal, and that keeps
   * timers and requests running only while at least one listener remains
   */
  subscribe: (listener: () => void) => () => void
}

export interface Activity {
  start: () => void
  stop: () => void
}

export function createListeners(activity?: Activity) {
  const entries = new Set<{ listener: () => void }>()

  const notify = () => {
    for (const entry of Array.from(entries)) {
      if (!entries.has(entry)) {
        continue
      }

      try {
        entry.listener()
      } catch (error) {
        console.error('[usher] listener threw', error)
      }
    }
  }

  const subscribe = (listener: () => void) => {
    const entry = { listener }
    entries.add(entry)

    if (entries.size === 1) {
      activity?.start()
    }

    return () => {
      if (entries.delete(entry) && entries.size === 0) {
        activity?.stop()
      }
    }
  }

  return { notify, subscribe }
}
