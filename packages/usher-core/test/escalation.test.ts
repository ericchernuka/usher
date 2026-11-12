import type { Attention } from '../src/types'
import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import {
  DAY,
  HOUR,
  MINUTE,
  describe,
  expect,
  newer,
  running,
  test,
  type StoreOptions,
} from './fixtures'

describe('escalating as the running build ages', () => {
  test.for<{
    name: string
    options: StoreOptions
    hours: number
    attention: Attention
  }>([
    {
      name: 'the prompt level is off',
      options: { promptAfter: false },
      hours: 23,
      attention: 'passive',
    },
    {
      name: 'the prompt level is off',
      options: { promptAfter: false },
      hours: 24,
      attention: 'urgent',
    },
    {
      name: 'the urgent level is off',
      options: { urgentAfter: false },
      hours: 48,
      attention: 'prompt',
    },
    {
      name: 'both levels are off',
      options: { promptAfter: false, urgentAfter: false },
      hours: 48,
      attention: 'passive',
    },
  ])(
    'given $name, then a $hours h old build is $attention',
    async ({ options, hours, attention }, { app, tab }) => {
      server.use(serveBuild(newer))
      const store = app.create({ pollInterval: HOUR, ...options })
      app.subscribe(store)
      await tab.waitForResponse()

      await tab.runFor(Date.parse(running.buildTime) + hours * HOUR - tab.now())

      expect(store.getState().attention).toBe(attention)
    },
  )

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

test('given thresholds longer than a browser timer can hold, then the tab still escalates on time', async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))

  const store = app.create({
    pollInterval: 40 * DAY,
    promptAfter: 30 * DAY,
    urgentAfter: false,
  })

  app.subscribe(store)
  await tab.waitForResponse()

  await tab.runFor(29 * DAY)
  expect(store.getState().attention).toBe('passive')

  await tab.runFor(DAY)
  expect(store.getState().attention).toBe('prompt')
})
