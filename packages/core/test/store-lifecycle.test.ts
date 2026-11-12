import { vi } from 'vitest'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  MINUTE,
  current,
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
    clock,
    requests,
  }) => {
    const store = app.create()
    await clock.settle()
    expect(requests).toHaveLength(0)

    const first = store.subscribe(() => {})
    const second = store.subscribe(() => {})
    await clock.settle()
    expect(requests).toHaveLength(1)

    first()
    await clock.runFor(5 * MINUTE)
    expect(requests).toHaveLength(2) // still one subscriber

    second()
    await clock.runFor(10 * MINUTE)
    expect(requests).toHaveLength(2) // stopped
  })

  test('given the same function subscribed twice, then each is its own subscription and unsubscribing is idempotent', async ({
    app,
    clock,
    requests,
  }) => {
    const store = app.create()
    const first = store.subscribe(noop)
    const second = app.subscribe(store, noop)
    await clock.settle()
    first()
    first()
    requests.length = 0

    await app.poll()

    expect(requests).toHaveLength(1) // still running for the second
    second()
  })

  test('given a listener throws, then the others still hear about the change', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = app.create()
    app.subscribe(store, () => {
      throw new Error('bad toast')
    })
    const later = vi.fn<() => void>()
    app.subscribe(store, later)
    await clock.settle()

    expect(later).toHaveBeenCalled()
    expect(store.getState().attention).toBe('passive')
  })

  test('given every subscriber left, when the app dismisses, then no timers are started', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T04:00:00Z')
    const store = app.create()
    const stop = app.subscribe(store)
    await clock.settle()
    stop()

    expect(store.dismiss()).toBe(true)

    expect(clock.pendingStoreTimers()).toBe(0)
  })
})

describe('snapshots', () => {
  test('given a poll that changes nothing, then getState() returns the same snapshot and listeners are not called', async ({
    app,
    clock,
    requests,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    const listener = vi.fn<() => void>()
    app.subscribe(store, listener)
    await clock.settle()
    const first = store.getState()
    listener.mockClear()

    await app.poll()

    expect(requests).toHaveLength(2)
    expect(store.getState()).toBe(first)
    expect(listener).not.toHaveBeenCalled()
  })

  test('given the server moves between builds, then no snapshot pairs an attention with the wrong latest', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    const seen: Array<[string, string | undefined]> = []
    app.subscribe(store, () =>
      seen.push([store.getState().attention, store.getState().latest?.version]),
    )
    await clock.settle()

    server.use(serveBuild(current))
    await app.poll()

    expect(seen).toEqual([
      ['urgent', 'old'],
      ['urgent', 'aaa'],
    ])
  })
})
