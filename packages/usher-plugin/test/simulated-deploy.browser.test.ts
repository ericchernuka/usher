import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAppUpdates } from '../src/client'
import { simulatedBuild, type SimulatedDeploy } from '../src/simulated-deploy'
import { runningBuild } from './build-info.stub'

const now = new Date('2026-11-11T16:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'],
  })
  vi.setSystemTime(now)
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each([
  ['advance', 'passive', 'outdated'],
  ['force', 'urgent', 'forced'],
  ['rollback', 'urgent', 'rollback'],
] as const)(
  'given a simulated %s deploy is served, then a tab on the real build reaches %s attention because it is %s',
  async (mode, attention, reason) => {
    const deploy: SimulatedDeploy = { mode, sequence: 1 }
    const served = simulatedBuild(runningBuild, deploy, now)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Response.json(served)),
    )
    const updates = createAppUpdates()
    const stop = updates.subscribe(() => {})

    try {
      await vi.waitFor(() =>
        expect(updates.getState()).toEqual({
          attention,
          reason,
          latest: served,
        }),
      )
    } finally {
      stop()
    }
  },
)
