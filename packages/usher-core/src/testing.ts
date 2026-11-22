import type { BuildFacts } from './build-facts'
import { createFakeEnvironment } from './fake-environment'
import { createTabIn, type Tab } from './tab'

/**
 * Tab with virtual time for testing update UI, offline until the first deploy,
 * whose clock starts at the real time, on a whole second, and then moves
 * only when advanced
 */
const SECOND = 1_000

export interface TestTab extends Tab {
  /** Build facts every later version check gets */
  deploy(build: BuildFacts): void
  /**
   * Virtual time moved forward, running the checks and timers that fall due,
   * with overlapping calls run one after another
   */
  advance(ms: number): Promise<void>
}

/** Create a test tab to pass as the second argument to `createAppUpdates` */
export function createTestTab(): TestTab {
  let served: BuildFacts | undefined
  let queue = Promise.resolve()

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

  fake.setSystemTime(Math.floor(Date.now() / SECOND) * SECOND)

  return Object.assign(createTabIn(fake.env), {
    deploy(build: BuildFacts) {
      served = build
    },
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(
          `[usher] advance needs a finite, non-negative number of milliseconds, got ${ms}`,
        )
      }

      const advanced = queue
        .then(fake.waitForResponse)
        .then(() => fake.runFor(ms))

      queue = advanced.catch(() => {})

      return advanced
    },
  })
}
