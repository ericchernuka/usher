import { createBrowserEnvironment, type Environment } from './environment'
import { createServerClock } from './server-clock'

const made = Symbol('usher tab')

/** Browser tab the app's updates run in, or a test tab standing in for one */
export interface Tab {
  /** Server time in milliseconds, the local clock until a version check answers */
  now: () => number
  readonly [made]: true
}

export interface Inside {
  env: Environment
  clock: ReturnType<typeof createServerClock>
}

const insides = new WeakMap<Tab, Inside>()

export function createTabIn(env: Environment): Tab {
  const clock = createServerClock(env)
  const tab: Tab = { now: clock.now, [made]: true }
  insides.set(tab, { env, clock })

  return tab
}

export function createTab(): Tab {
  return createTabIn(createBrowserEnvironment())
}

export function insideTab(tab: Tab): Inside {
  const inside = insides.get(tab)

  if (!inside) {
    throw new Error(
      '[usher] this tab was not made by this copy of @rndsqr/usher-core. Create it with createTestTab() from @rndsqr/usher-core/testing, and check that only one version of @rndsqr/usher-core is installed.',
    )
  }

  return inside
}
