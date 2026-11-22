import type { BuildFacts } from './build-facts'
import { createFakeEnvironment } from './fake-environment'
import { createTabIn, type Tab } from './tab'

export interface TestTab extends Tab {
  deploy(build: BuildFacts): void
  advance(ms: number): Promise<void>
}

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
