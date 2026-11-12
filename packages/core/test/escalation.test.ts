import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import { HOUR, MINUTE, describe, expect, newer, older, test } from './fixtures'

describe('escalating as the running build ages', () => {
  test('given a backward clock change and a failed focus check, then urgency still starts on time', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T14:58:00Z')
    server.use(serveBuild(newer, { date: new Date(Date.now()) }))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    expect(store.getState().attention).toBe('prompt')

    await clock.runFor(MINUTE)
    clock.setSystemTime(Date.now() - HOUR)
    server.use(serveNetworkError())
    host.focus()
    await clock.settle()
    await clock.runFor(MINUTE)

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'expired',
    })
  })

  test('given a deploy and every later check fails, then the tab still escalates on time', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    expect(store.getState().attention).toBe('passive')

    server.use(serveNetworkError())
    await clock.runFor(11 * HOUR) // the build is now 12 h old

    expect(store.getState()).toMatchObject({
      attention: 'prompt',
      reason: 'stale',
    })

    await clock.runFor(12 * HOUR) // 24 h

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'expired',
    })
  })
})

test('given typing when a rollback lands, then urgency is immediate', async ({
  app,
  clock,
  host,
}) => {
  server.use(serveBuild(older))
  const store = app.create()
  app.subscribe(store)
  host.keydown()
  await clock.settle()
  expect(store.getState()).toMatchObject({
    attention: 'urgent',
    reason: 'rollback',
  })
})

test('given time passed while hidden, then visibility evaluates age even if the next check fails', async ({
  app,
  clock,
  host,
}) => {
  server.use(serveBuild(newer))
  const store = app.create()
  app.subscribe(store)
  await clock.settle()
  host.setVisibility('hidden')
  expect(clock.pendingStoreTimers()).toBe(0)
  await clock.runFor(24 * HOUR)
  server.use(serveNetworkError())
  host.setVisibility('visible')
  await clock.settle()
  expect(store.getState().reason).toBe('expired')
})

test('given time passed while unsubscribed, then subscribing evaluates age before a failed check', async ({
  app,
  clock,
}) => {
  server.use(serveBuild(newer))
  const store = app.create()
  const stop = app.subscribe(store)
  await clock.settle()
  stop()
  await clock.runFor(24 * HOUR)
  server.use(serveNetworkError())
  app.subscribe(store)
  expect(store.getState().reason).toBe('expired')
})
