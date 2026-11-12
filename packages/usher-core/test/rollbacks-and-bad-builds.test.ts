import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { HOUR, running, describe, expect, newer, older, test } from './fixtures'

describe('a rollback', () => {
  test('given the server redeploys an older commit, then the tab is urgent at once', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
      latest: { version: 'old' },
    })
  })

  test('given the tab learned its build is bad, when a fix ships, then it stays urgent as a rollback', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    server.use(serveBuild(newer))
    await app.poll()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
      latest: { version: 'bbb' },
    })
  })
})

describe('a forced update', () => {
  test('given the same version is rebuilt with a cutoff after our build, then the tab is forced', async ({
    app,
    tab,
  }) => {
    server.use(
      serveBuild({
        ...running,
        buildTime: '2026-11-11T15:30:00.000Z',
        forceUpdateBuiltBefore: '2026-11-11T15:30:00.000Z',
      }),
    )
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'forced',
    })
  })

  test('given a cutoff older than our build, then it does not apply', async ({
    app,
    tab,
  }) => {
    server.use(
      serveBuild({
        ...newer,
        forceUpdateBuiltBefore: new Date(
          Date.parse(running.buildTime) - HOUR,
        ).toISOString(),
      }),
    )
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'outdated',
    })
  })

  test('given a cutoff later than the serving build itself, then it does not apply, because refreshing could never satisfy it', async ({
    app,
    tab,
  }) => {
    server.use(
      serveBuild({
        ...newer,
        forceUpdateBuiltBefore: '2026-11-12T09:00:00.000Z',
      }),
    )
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'outdated',
    })
  })
})
