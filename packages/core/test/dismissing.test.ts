import { vi } from 'vitest'
import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  SNOOZE_KEY,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

describe('how long a dismissal lasts', () => {
  test('given the user dismissed urgent with a 1 minute snooze, then urgent returns when it ends, without waiting for a poll', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))

    const store = app.create({
      escalation: { urgent: { after: '24h', snooze: '1m' } },
      pollEvery: '60m',
    })

    app.subscribe(store)
    await clock.settle()
    store.dismiss()
    expect(store.getState().attention).toBe('passive')

    await clock.runFor(61_000)

    expect(store.getState().attention).toBe('urgent')
  })

  test('given a snooze longer than a timer can hold (40 days), then the tab keeps one wake-up and no request storm', async ({
    app,
    clock,
    requests,
  }) => {
    server.use(serveBuild(older))

    const store = app.create({
      escalation: { urgent: { after: '24h', snooze: '40d' } },
    })

    app.subscribe(store)
    await clock.settle()
    store.dismiss()
    const checks = requests.length

    await clock.runFor(100)

    expect(requests).toHaveLength(checks)
    expect(clock.pendingStoreTimers()).toBe(1)
  })

  test('given the user dismissed the prompt level, then it stays quiet until the urgent level starts', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T04:00:00Z') // 13 h: prompt:stale
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    expect(store.getState().reason).toBe('stale')

    store.dismiss()
    await clock.runFor(10 * HOUR) // 23 h: still quiet

    expect(store.getState().attention).toBe('passive')

    await clock.runFor(HOUR) // 24 h: urgent

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
    await clock.runFor(60_900) // checks now land at .900 ms: the header rounds down
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

  test("given the user's own clock jumps a day forward, then an urgent snooze still holds", async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    await clock.runFor(23 * HOUR)
    expect(store.dismiss()).toBe(true)

    vi.setSystemTime(Date.now() + 24 * HOUR) // the user's clock only
    server.use(serveNetworkError()) // no check to correct it
    await clock.runFor(10 * MINUTE)

    expect(store.getState().reason).toBe('dismiss')
  })
})

describe('dismissing when there is nothing to dismiss', () => {
  test('given a raise is held for a busy user, when the app dismisses, then nothing changes and nothing is saved', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const offered: string[] = []

    const store = app.create({
      idleFor: '5s',
      onAttentionChange: (attention, details) =>
        offered.push(`${attention}:${details.reason}`),
    })

    app.subscribe(store)
    host.keydown()
    await clock.settle()
    expect(store.getState().attention).toBe('passive')
    offered.length = 0

    expect(store.dismiss()).toBe(false)

    expect(offered).toEqual([])
    expect(host.localStorage.getItem(SNOOZE_KEY)).toBeNull()
  })
})
