import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { HOUR, current, describe, expect, newer, older, test } from './fixtures'

describe('a rollback', () => {
  test('given the server redeploys an older commit, then the tab is urgent at once', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()

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
    await clock.waitForResponse()

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
    clock,
  }) => {
    server.use(
      serveBuild({ ...current, forceUpdateBefore: '2026-11-11T15:30:00.000Z' }),
    )
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()

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
    await clock.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'new-build',
    })
  })
})
