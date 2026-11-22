export interface Readable<Value> {
  get: () => Value
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
