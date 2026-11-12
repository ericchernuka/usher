import type { Host } from './host'
import type { ReloadDetails, ReloadFn } from './types'

/** Return true to block the reload. Must be synchronous. */
export type ReloadBlocker = (details: ReloadDetails) => boolean

function createBlockers() {
  const blockers = new Set<{ blocker: ReloadBlocker }>()

  return {
    add: (blocker: ReloadBlocker) => {
      const entry = { blocker }
      blockers.add(entry)

      return () => void blockers.delete(entry)
    },
    blocked(details: ReloadDetails): boolean {
      for (const { blocker } of blockers) {
        try {
          if (blocker(details)) {
            return true
          }
        } catch (error) {
          console.error('[app-version] reload blocker threw', error)

          return true
        }
      }

      return false
    },
  }
}

async function perform(
  reload: ReloadFn,
  details: ReloadDetails,
): Promise<boolean> {
  try {
    return (await reload(details)) !== false
  } catch (error) {
    console.error('[app-version] reload threw', error)

    return false
  }
}

export interface ReloadsOptions {
  reload?: ReloadFn
  host: Host
}

export function createReloads({ reload, host }: ReloadsOptions) {
  const blockers = createBlockers()
  const performReload = reload ?? (() => host.location.reload())
  let inFlight: Promise<boolean> | undefined

  function request(details: ReloadDetails): Promise<boolean> {
    if (inFlight) {
      return inFlight
    }

    if (blockers.blocked(details)) {
      return Promise.resolve(false)
    }

    const attempt = perform(performReload, details).finally(() => {
      inFlight = undefined
    })

    inFlight = attempt

    return attempt
  }

  return { request, addBlocker: blockers.add }
}
