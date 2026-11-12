import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  SNOOZE_KEY,
  expect,
  newer,
  older,
  test,
} from './fixtures'

test('given the user dismissed the prompt level, then it stays quiet until the urgent level starts', async ({
  app,
  clock,
}) => {
  server.use(serveBuild(newer))
  clock.setSystemTime('2026-11-12T04:00:00Z')
  const store = app.create()
  app.subscribe(store)
  await clock.settle()
  expect(store.getState().reason).toBe('stale')

  store.dismiss()
  await clock.runFor(10 * HOUR)

  expect(store.getState().attention).toBe('passive')

  await clock.runFor(HOUR)

  expect(store.getState().reason).toBe('expired')
})

test("given Date headers round down to the second, then a prompt dismissal can't end before urgent starts", async ({
  app,
  clock,
  host,
}) => {
  server.use(serveBuild(newer))
  const states: string[] = []
  const store = app.create()
  app.subscribe(store, () =>
    states.push(`${store.getState().attention}:${store.getState().reason}`),
  )
  await clock.settle()
  await clock.runFor(12 * HOUR)
  expect(store.dismiss()).toBe(true)
  await clock.runFor(60_900)
  host.focus()
  await clock.settle()
  states.length = 0

  await clock.runFor(11 * HOUR)

  expect(states).not.toContain('prompt:stale')
  expect(store.getState()).toMatchObject({
    attention: 'urgent',
    reason: 'expired',
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
    name: 'expired',
    build: newer,
    time: '2026-11-12T16:00:00Z',
    reason: 'expired',
  },
  {
    name: 'forced',
    build: { ...newer, forceUpdateBefore: '2026-11-12T00:00:00Z' },
    time: '2026-11-11T16:00:00Z',
    reason: 'forced',
  },
])(
  'given $name urgency, then dismiss changes neither state nor storage',
  async ({ build, time, reason }, { app, clock, host }) => {
    clock.setSystemTime(time)
    server.use(serveBuild(build))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    const before = store.getState()
    expect(before.reason).toBe(reason)
    expect(store.dismiss()).toBe(false)
    expect(store.getState()).toBe(before)
    expect(host.localStorage.getItem(SNOOZE_KEY)).toBeNull()
  },
)

test('given a default prompt snooze and a clock jump, then it stays quiet until the urgent deadline', async ({
  app,
  clock,
}) => {
  clock.setSystemTime('2026-11-12T04:00:00Z')
  server.use(serveBuild(newer))
  const store = app.create()
  app.subscribe(store)
  await clock.settle()
  expect(store.dismiss()).toBe(true)
  clock.setSystemTime(Date.now() + 24 * HOUR)
  server.use(serveNetworkError())
  await clock.runFor(10 * MINUTE)
  expect(store.getState().reason).toBe('dismiss')
})

test('given a custom prompt snooze, then its expiry wakes without another poll', async ({
  app,
  clock,
}) => {
  server.use(serveBuild(newer))

  const store = app.create({
    pollEvery: '60m',
    escalation: { prompt: { after: '1h', snooze: '1m' } },
  })

  app.subscribe(store)
  await clock.settle()
  expect(store.dismiss()).toBe(true)
  await clock.runFor(61_000)
  expect(store.getState().attention).toBe('prompt')
})

test('given no prompt, then dismiss has no effect', ({ app, host }) => {
  const store = app.create()
  expect(store.dismiss()).toBe(false)
  expect(host.localStorage.getItem(SNOOZE_KEY)).toBeNull()
})

test('given a hidden prompt passes the urgent deadline, then dismissal writes nothing and visibility reveals urgent', async ({
  app,
  clock,
  host,
}) => {
  clock.setSystemTime('2026-11-12T04:00:00Z')
  server.use(serveBuild(newer))
  const store = app.create()
  app.subscribe(store)
  await clock.settle()
  host.setVisibility('hidden')
  await clock.runFor(12 * HOUR)
  const before = store.getState()
  expect(before.attention).toBe('prompt')
  expect(store.dismiss()).toBe(false)
  expect(store.getState()).toBe(before)
  expect(host.localStorage.getItem(SNOOZE_KEY)).toBeNull()
  host.setVisibility('visible')
  expect(store.getState().reason).toBe('expired')
})
