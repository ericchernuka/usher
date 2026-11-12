import type { AppUpdatesOptions } from './types'

/** Return true to block the refresh. Must be synchronous. */
export type RefreshBlocker = () => boolean

type Reload = NonNullable<AppUpdatesOptions['reload']>

function createBlockers() {
  const blockers = new Set<{ blocker: RefreshBlocker }>()

  return {
    add: (blocker: RefreshBlocker) => {
      const entry = { blocker }
      blockers.add(entry)

      return () => void blockers.delete(entry)
    },
    blocked(): boolean {
      for (const { blocker } of blockers) {
        try {
          if (blocker()) {
            return true
          }
        } catch (error) {
          console.error('[app-version] refresh blocker threw', error)

          return true
        }
      }

      return false
    },
  }
}

async function perform(reload: Reload): Promise<boolean> {
  try {
    return (await reload()) !== false
  } catch (error) {
    console.error('[app-version] reload threw', error)

    return false
  }
}

/** Owns refresh blockers and the one refresh attempt that concurrent callers share. */
export function createRefresh(
  reload: NonNullable<AppUpdatesOptions['reload']>,
) {
  const blockers = createBlockers()
  let inFlight: Promise<boolean> | undefined

  function request(): Promise<boolean> {
    if (inFlight) {
      return inFlight
    }

    if (blockers.blocked()) {
      return Promise.resolve(false)
    }

    const attempt = perform(reload).finally(() => {
      inFlight = undefined
    })

    inFlight = attempt

    return attempt
  }

  return { request, addBlocker: blockers.add }
}
