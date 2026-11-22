import type { BuildFacts } from './build-facts'
import { createFakeEnvironment } from './fake-environment'
import { createTabIn, type Tab } from './tab'

/** Tab with virtual time for testing update UI, offline until the first deploy */
export interface TestTab extends Tab {
  /** Build facts every later version check gets */
  deploy(build: BuildFacts): void
  /** Virtual time moved forward, running the checks and timers that fall due */
  advance(ms: number): Promise<void>
}

/** Create a test tab to pass as the second argument to `createAppUpdates` */
export function createTestTab(): TestTab {
  let served: BuildFacts | undefined

  const fake = createFakeEnvironment({
    fetch: async () => {
      if (!served) {
        throw new TypeError('nothing is deployed')
      }

      return Response.json(served, {
        headers: { date: new Date(fake.now()).toUTCString() },
      })
    },
  })

  return Object.assign(createTabIn(fake.env), {
    deploy(build: BuildFacts) {
      served = build
    },
    advance: fake.runFor,
  })
}
