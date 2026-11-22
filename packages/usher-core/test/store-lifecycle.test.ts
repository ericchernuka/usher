import { vi } from 'vitest'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  running,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

const noop = () => {}

describe('subscribing', () => {
  test('given no subscribers, then the store does nothing; it polls while at least one remains and stops after the last', async ({
    app,
    tab,
    requests,
  }) => {
    const store = app.create()
    await tab.waitForResponse()
    expect(requests).toHaveLength(0)

    const first = store.subscribe(() => {})
    const second = store.subscribe(() => {})
    await tab.waitForResponse()
    expect(requests).toHaveLength(1)

    first()
    await tab.runFor(5 * MINUTE)
    expect(requests).toHaveLength(2)

    second()
    await tab.runFor(10 * MINUTE)
    expect(requests).toHaveLength(2)
  })

  test('given the same function subscribed twice, then each is its own subscription and unsubscribing is idempotent', async ({
    app,
    tab,
    requests,
  }) => {
    const store = app.create()
    const first = store.subscribe(noop)
    const second = app.subscribe(store, noop)
    await tab.waitForResponse()
    first()
    first()
    requests.length = 0

    await app.poll()

    expect(requests).toHaveLength(1)
    second()
  })

  test('given a listener throws, then the others still hear about the change', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = app.create()
    app.subscribe(store, () => {
      throw new Error('bad toast')
    })
    const later = vi.fn<() => void>()
    app.subscribe(store, later)
    await tab.waitForResponse()

    expect(later).toHaveBeenCalled()
    expect(store.getState().attention).toBe('passive')
  })

  test('given a listener removes a later one, then the removed listener does not hear that change', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    const removed = vi.fn<() => void>()
    let stopRemoved = noop
    app.subscribe(store, () => stopRemoved())
    stopRemoved = app.subscribe(store, removed)
    await tab.waitForResponse()

    expect(store.getState().attention).toBe('passive')
    expect(removed).not.toHaveBeenCalled()
  })

  test('given every subscriber left, when the app dismisses, then no timers are started', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    tab.setSystemTime('2026-11-12T04:00:00Z')
    const store = app.create()
    const stop = app.subscribe(store)
    await tab.waitForResponse()
    stop()

    expect(store.dismiss()).toBe(true)

    expect(tab.pendingTimers()).toBe(0)
  })

  test('given the last subscriber leaves when a tab returns to an escalated state, then no timers remain', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    const first = app.subscribe(store)
    await tab.waitForResponse()
    let leave = noop
    leave = app.subscribe(store, () => leave())
    first()
    tab.setVisibility('hidden')
    await tab.advance(13 * HOUR)

    tab.setVisibility('visible')
    expect(store.getState().attention).toBe('prompt')
    await tab.flush()

    expect(tab.pendingTimers()).toBe(0)
  })
})

describe('snapshots', () => {
  test('given a poll that changes nothing, then getState() returns the same snapshot and listeners are not called', async ({
    app,
    tab,
    requests,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    const listener = vi.fn<() => void>()
    app.subscribe(store, listener)
    await tab.waitForResponse()
    const first = store.getState()
    listener.mockClear()

    await app.poll()

    expect(requests).toHaveLength(2)
    expect(store.getState()).toBe(first)
    expect(listener).not.toHaveBeenCalled()
  })

  test('given the server moves between builds, then no snapshot pairs an attention with the wrong latest', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    const seen: Array<[string, string | undefined]> = []
    app.subscribe(store, () => {
      const state = store.getState()
      seen.push([state.attention, state.latest?.version])
    })
    await tab.waitForResponse()

    server.use(serveBuild(running))
    await app.poll()

    expect(seen).toEqual([
      ['urgent', 'old'],
      ['urgent', 'aaa'],
    ])
  })

  test('given the same version is rebuilt, when the check lands, then the snapshot carries the new build facts', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    const listener = vi.fn<() => void>()
    app.subscribe(store, listener)
    await tab.waitForResponse()
    const first = store.getState()
    listener.mockClear()

    const rebuilt = { ...newer, buildTime: '2026-11-11T15:45:00.000Z' }
    server.use(serveBuild(rebuilt))
    await app.poll()

    expect(store.getState()).not.toBe(first)
    expect(store.getState()).toEqual({
      attention: 'passive',
      reason: 'outdated',
      latest: rebuilt,
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
