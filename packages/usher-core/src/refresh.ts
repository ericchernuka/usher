import type { AppUpdatesOptions } from './types'

/** Return true to block the refresh. Must be synchronous. */
export type RefreshBlocker = () => boolean

/**
 * What became of a refresh.
 *
 * - `reloading`: `reload` ran, and the document is being replaced.
 * - `blocked`: a refresh blocker stopped it before `reload` ran.
 * - `declined`: `reload` returned `false` or threw.
 */
export type RefreshOutcome = 'reloading' | 'blocked' | 'declined'

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
          console.error('[usher] refresh blocker threw', error)

          return true
        }
      }

      return false
    },
  }
}

async function perform(reload: Reload): Promise<RefreshOutcome> {
  try {
    return (await reload()) === false ? 'declined' : 'reloading'
  } catch (error) {
    console.error('[usher] reload threw', error)

    return 'declined'
  }
}

export function createRefresh(
  reload: NonNullable<AppUpdatesOptions['reload']>,
) {
  const blockers = createBlockers()
  let inFlight: Promise<RefreshOutcome> | undefined

  function request(): Promise<RefreshOutcome> {
    if (inFlight) {
      return inFlight
    }

    if (blockers.blocked()) {
      return Promise.resolve('blocked')
    }

    const attempt = perform(reload).finally(() => {
      inFlight = undefined
    })

    inFlight = attempt

    return attempt
  }

  return { request, addBlocker: blockers.add }
}
