import { server } from './mocks/node'
import { serveBuild, serveNetworkError } from './mocks/overrides'
import { HOUR, MINUTE, describe, expect, newer, older, test } from './fixtures'

describe('escalating as the running build ages', () => {
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

describe('raising attention only for an idle, visible user', () => {
  test('given the user is typing when a rollback lands, then it waits and raises once they have been idle', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create({ idleFor: '5s' })
    app.subscribe(store)
    host.keydown()
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'waiting',
    })

    await clock.runFor(5_000)

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
  })

  test('given a raise is held and the tab is hidden, then no timers run and it releases on return even if that check fails', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create({ idleFor: '5s' })
    app.subscribe(store)
    host.keydown() // busy while the check is in flight
    await clock.settle()
    expect(store.getState().attention).toBe('passive')

    host.setVisibility('hidden')
    expect(clock.pendingStoreTimers()).toBe(0)
    await clock.runFor(10 * MINUTE)
    expect(store.getState().attention).toBe('passive')

    server.use(serveNetworkError()) // the check on return fails
    host.setVisibility('visible')
    await clock.settle()

    expect(store.getState().attention).toBe('urgent') // released from what it already knew
  })

  test('given a raise was held, when the user goes idle while unsubscribed and the next check fails, then resubscribing releases it at once', async ({
    app,
    clock,
    host,
  }) => {
    // Found by the model test: resubscribing only started a check, so a raise held for a busy
    // user stayed "waiting" until that check landed, or a whole poll later if it failed.
    server.use(serveBuild(older))
    const store = app.create({ idleFor: '5s' })
    const stop = app.subscribe(store)
    host.keydown()
    await clock.settle()
    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'waiting',
    })

    stop() // e.g. the component that subscribed unmounts
    await clock.runFor(6_000) // the user goes idle meanwhile
    server.use(serveNetworkError())
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
  })
})
