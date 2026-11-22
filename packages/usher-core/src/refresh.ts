import { resolveRefresh, type RefreshOptions } from './options'
import { createListeners, type Readable } from './readable'
import { insideTab, type Tab } from './tab'

/** Synchronous veto on a refresh that blocks by returning `true` or throwing */
export type RefreshBlocker = () => boolean

/**
 * Result of a refresh: `reloading` once `reload` ran, `blocked` by a refresh
 * blocker, or `declined` when `reload` returned `false` or threw
 */
export type RefreshOutcome = 'reloading' | 'blocked' | 'declined'

/** Refresh behaviour whose value is whether a refresh is in flight */
export interface Refresh extends Readable<boolean> {
  /**
   * Refresh attempt shared by concurrent callers, with nothing remembered
   * afterwards so any outcome can be retried
   */
  run: () => Promise<RefreshOutcome>
  /** Refresh blocker registration that returns its own removal */
  addBlocker: (blocker: RefreshBlocker) => () => void
}

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

export function createRefresh(tab: Tab, options: RefreshOptions = {}): Refresh {
  resolveRefresh(options)

  const { env } = insideTab(tab)

  const reload: NonNullable<RefreshOptions['reload']> =
    options.reload ?? (() => env.reload())

  const blockers = createBlockers()
  const listeners = createListeners()
  let inFlight: Promise<RefreshOutcome> | undefined

  async function perform(): Promise<RefreshOutcome> {
    try {
      return (await reload()) === false ? 'declined' : 'reloading'
    } catch (error) {
      console.error('[usher] reload threw', error)

      return 'declined'
    }
  }

  function run(): Promise<RefreshOutcome> {
    if (inFlight) {
      return inFlight
    }

    if (blockers.blocked()) {
      return Promise.resolve('blocked')
    }

    let settle!: (outcome: Promise<RefreshOutcome>) => void

    const attempt = new Promise<RefreshOutcome>(resolve => {
      settle = resolve
    }).finally(() => {
      inFlight = undefined
      listeners.notify()
    })

    inFlight = attempt
    listeners.notify()
    settle(perform())

    return attempt
  }

  return {
    get: () => inFlight !== undefined,
    subscribe: listeners.subscribe,
    run,
    addBlocker: blockers.add,
  }
}
