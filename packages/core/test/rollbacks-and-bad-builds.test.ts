import type { VersionInfo } from '../src/index'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  current,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

describe('a rollback', () => {
  test('given the server redeploys an older commit, then the tab is urgent at once', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
      latest: { version: 'old' },
    })
  })

  test('given the tab learned its build is bad, when a fix ships, then it stays urgent as a rollback', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    server.use(serveBuild(newer)) // a fix, newer than us
    await app.poll()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
      latest: { version: 'bbb' },
    })
  })

  test('given the user dismissed the rollback, when the latest build flaps between deploys, then the dismissal holds', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const states: string[] = []
    const store = app.create()
    app.subscribe(store, () => states.push(store.getState().attention))
    await clock.settle()
    expect(store.dismiss()).toBe(true)
    states.length = 0

    const deploy = async (build: VersionInfo) => {
      server.use(serveBuild(build))
      await clock.runFor(5 * MINUTE)
    }

    await deploy(newer)
    await deploy(older)
    await deploy(newer)
    await deploy(older)

    expect(states).not.toContain('urgent')
  })

  test('given the user dismissed an expired build, when a rollback appears inside the snooze, then it breaks through', async ({
    app,
    clock,
  }) => {
    // Acknowledgements are per build and evidence: new evidence is not covered by an old dismissal.
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T16:00:00Z') // 25 h: expired
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    expect(store.getState().reason).toBe('expired')
    store.dismiss()

    server.use(serveBuild(older))
    await app.poll()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
  })
})

describe('a forced update', () => {
  test('given the same version is rebuilt with a cutoff after our build, then the tab is forced', async ({
    app,
    clock,
  }) => {
    server.use(
      serveBuild({ ...current, forceUpdateBefore: '2026-11-11T15:30:00.000Z' }),
    )
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'forced',
    })
  })

  test('given a cutoff older than our build, then it does not apply', async ({
    app,
    clock,
  }) => {
    server.use(
      serveBuild({
        ...newer,
        forceUpdateBefore: new Date(
          Date.parse(current.builtAt) - HOUR,
        ).toISOString(),
      }),
    )
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'new-build',
    })
  })
})
