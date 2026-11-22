import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  SECOND,
  DISMISSAL_KEY,
  expect,
  newer,
  older,
  test,
} from './fixtures'

test('given the user dismissed the prompt level, then it stays quiet until the urgent level starts', async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))
  tab.setSystemTime('2026-11-12T04:00:00Z')
  const store = app.create()
  app.subscribe(store)
  await tab.waitForResponse()
  expect(store.state.get().attention).toBe('prompt')

  store.state.dismiss()
  await tab.runFor(10 * HOUR)

  expect(store.state.get().attention).toBe('passive')

  await tab.runFor(HOUR)

  expect(store.state.get().attention).toBe('urgent')
})

test("given Date headers round down to the second, then a prompt dismissal can't end before urgent starts", async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))
  const states: string[] = []
  const store = app.create()
  app.subscribe(store, () =>
    states.push(`${store.state.get().attention}:${store.state.get().reason}`),
  )
  await tab.waitForResponse()
  await tab.runFor(12 * HOUR)
  expect(store.state.dismiss()).toBe(true)
  await tab.runFor(60_900)
  tab.focus()
  await tab.waitForResponse()
  states.length = 0

  await tab.runFor(11 * HOUR)

  expect(states).not.toContain('prompt:outdated')
  expect(store.state.get()).toMatchObject({
    attention: 'urgent',
    reason: 'outdated',
  })
})

test.for([
  {
    name: 'rollback',
    build: older,
    time: '2026-11-11T16:00:00Z',
    reason: 'rollback',
  },
  {
    name: 'outdated',
    build: newer,
    time: '2026-11-12T16:00:00Z',
    reason: 'outdated',
  },
  {
    name: 'forced',
    build: {
      ...newer,
      buildTime: '2026-11-11T15:30:00.000Z',
      forceUpdateBuiltBefore: '2026-11-11T15:30:00.000Z',
    },
    time: '2026-11-11T16:00:00Z',
    reason: 'forced',
  },
])(
  'given $name urgency, then dismiss changes neither state nor storage',
  async ({ build, time, reason }, { app, tab }) => {
    tab.setSystemTime(time)
    server.use(serveBuild(build))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    const before = store.state.get()
    expect(before).toMatchObject({ attention: 'urgent', reason })
    expect(store.state.dismiss()).toBe(false)
    expect(store.state.get()).toBe(before)
    expect(tab.storage.getItem(DISMISSAL_KEY)).toBeNull()
  },
)

test('given a default prompt snooze, then a forward jump of the wall clock does not end it', async ({
  app,
  tab,
}) => {
  tab.setSystemTime('2026-11-12T04:00:00Z')
  server.use(serveBuild(newer))
  const store = app.create()
  app.subscribe(store)
  await tab.waitForResponse()
  expect(store.state.dismiss()).toBe(true)
  tab.setSystemTime(tab.now() + 24 * HOUR)
  server.use(serveNetworkError())
  await tab.runFor(10 * MINUTE)
  expect(store.state.get().reason).toBe('dismissed')
})

test('given a custom prompt snooze, then its expiry wakes without another poll', async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))

  const store = app.create({
    pollInterval: HOUR,
    promptAfter: HOUR,
    promptSnooze: MINUTE,
  })

  app.subscribe(store)
  await tab.waitForResponse()
  expect(store.state.dismiss()).toBe(true)
  await tab.runFor(61_000)
  expect(store.state.get().attention).toBe('prompt')
})

test('given a listener dismisses as soon as it hears of the prompt, then the snooze still ends on time', async ({
  app,
  tab,
}) => {
  server.use(serveBuild(newer))

  const store = app.create({
    pollInterval: HOUR,
    promptAfter: HOUR,
    promptSnooze: MINUTE,
  })

  let dismissals = 0

  app.subscribe(store, () => {
    if (store.state.dismiss()) {
      dismissals += 1
    }
  })

  await tab.waitForResponse()
  await tab.runFor(3 * MINUTE + SECOND)

  expect(dismissals).toBe(4)
})

test('given the urgent level is off, then a prompt dismissal never expires', async ({
  app,
  tab,
}) => {
  tab.setSystemTime('2026-11-12T04:00:00Z')
  server.use(serveBuild(newer))
  const store = app.create({ urgentAfter: false, pollInterval: HOUR })
  app.subscribe(store)
  await tab.waitForResponse()
  expect(store.state.dismiss()).toBe(true)

  await tab.runFor(48 * HOUR)

  expect(store.state.get()).toMatchObject({
    attention: 'passive',
    reason: 'dismissed',
  })
})

test('given no prompt, then dismiss has no effect', ({ app, tab }) => {
  const store = app.create()
  expect(store.state.dismiss()).toBe(false)
  expect(tab.storage.getItem(DISMISSAL_KEY)).toBeNull()
})

test('given a hidden prompt passes the urgent deadline, then dismissal writes nothing and visibility reveals urgent', async ({
  app,
  tab,
}) => {
  tab.setSystemTime('2026-11-12T04:00:00Z')
  server.use(serveBuild(newer))
  const store = app.create()
  app.subscribe(store)
  await tab.waitForResponse()
  tab.setVisibility('hidden')
  await tab.runFor(12 * HOUR)
  const before = store.state.get()
  expect(before.attention).toBe('prompt')
  expect(store.state.dismiss()).toBe(false)
  expect(store.state.get()).toBe(before)
  expect(tab.storage.getItem(DISMISSAL_KEY)).toBeNull()
  tab.setVisibility('visible')
  expect(store.state.get().attention).toBe('urgent')
})
