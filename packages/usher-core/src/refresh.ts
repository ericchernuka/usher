import { resolveRefresh, type RefreshOptions } from './options'
import { createListeners, type Readable } from './readable'
import { insideTab, type Tab } from './tab'

export type RefreshBlocker = () => boolean

export type RefreshOutcome = 'reloading' | 'blocked' | 'declined'

export interface Refresh extends Readable<boolean> {
  run: () => Promise<RefreshOutcome>
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
