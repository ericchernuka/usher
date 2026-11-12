import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import { HOUR, MINUTE, describe, expect, newer, test } from './fixtures'

describe('escalating as the running build ages', () => {
  test('given a backward clock change and a failed focus check, then urgency still starts on time', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T14:58:00Z')
    server.use(serveBuild(newer, { date: new Date(tab.now()) }))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    expect(store.getState().attention).toBe('prompt')

    await tab.runFor(MINUTE)
    tab.setSystemTime(tab.now() - HOUR)
    server.use(serveNetworkError())
    tab.focus()
    await tab.waitForResponse()
    await tab.runFor(MINUTE)

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'outdated',
    })
  })

  test('given a deploy and every later check fails, then the tab still escalates on time', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    expect(store.getState().attention).toBe('passive')

    server.use(serveNetworkError())
    await tab.runFor(11 * HOUR)

    expect(store.getState()).toMatchObject({
      attention: 'prompt',
      reason: 'outdated',
    })

    await tab.runFor(12 * HOUR)

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'outdated',
    })
  })
})

test('given time passed while hidden, then visibility evaluates age even if the next check fails', async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))
  const store = app.create()
  app.subscribe(store)
  await tab.waitForResponse()
  tab.setVisibility('hidden')
  expect(tab.pendingTimers()).toBe(0)
  await tab.runFor(24 * HOUR)
  server.use(serveNetworkError())
  tab.setVisibility('visible')
  await tab.waitForResponse()
  expect(store.getState().attention).toBe('urgent')
})

test('given time passed while unsubscribed, then subscribing evaluates age before a failed check', async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))
  const store = app.create()
  const stop = app.subscribe(store)
  await tab.waitForResponse()
  stop()
  await tab.runFor(24 * HOUR)
  server.use(serveNetworkError())
  app.subscribe(store)
  expect(store.getState().attention).toBe('urgent')
})
