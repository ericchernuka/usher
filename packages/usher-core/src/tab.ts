import { createBrowserEnvironment, type Environment } from './environment'
import { createServerClock } from './server-clock'

export interface Tab {
  now(): number
}

export interface Inside {
  env: Environment
  clock: ReturnType<typeof createServerClock>
}

const insides = new WeakMap<Tab, Inside>()

export function createTabIn(env: Environment): Tab {
  const clock = createServerClock(env)
  const tab: Tab = { now: clock.now }
  insides.set(tab, { env, clock })

  return tab
}

export function createTab(): Tab {
  return createTabIn(createBrowserEnvironment())
}

export function insideTab(tab: Tab): Inside {
  const inside = insides.get(tab)

  if (!inside) {
    throw new Error('[usher] tab must come from createTestTab()')
  }

  return inside
}
