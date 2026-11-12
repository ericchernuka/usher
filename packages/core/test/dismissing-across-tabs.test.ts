import { vi } from 'vitest'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { HOUR, DISMISSAL_KEY, describe, expect, newer, test } from './fixtures'

describe('reading what other tabs left in storage', () => {
  test.for([
    { name: 'not JSON', stored: '{oops' },
    { name: 'not an object', stored: '"dismissed"' },
    { name: 'an array', stored: '[1, 2]' },
    {
      name: 'a record with unreadable fields',
      stored: '{"dismissedAt":"soon","urgentAt":null}',
    },
  ])(
    'given storage holds $name, when the tab starts, then nothing is dismissed',
    async ({ stored }, { app, clock, host }) => {
      clock.setSystemTime('2026-11-12T04:00:00Z')
      server.use(serveBuild(newer))
      host.localStorage.setItem(DISMISSAL_KEY, stored)
      const store = app.create()
      app.subscribe(store)
      await clock.waitForResponse()

      expect(store.getState()).toMatchObject({
        attention: 'prompt',
        reason: 'outdated',
      })
    },
  )
})

describe('hearing from other tabs while running', () => {
  test('given another tab writes garbage, then this tab keeps its own dismissal', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()
    store.dismiss()

    host.otherTabSets(DISMISSAL_KEY, '{oops')

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismissed',
    })
  })

  test('given sessionStorage is cleared, then a localStorage dismissal is not undone', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()
    store.dismiss()

    host.storageEventFor(null, host.sessionStorage)

    expect(store.getState().attention).toBe('passive')
  })
})

describe('a dismissal this tab could not save', () => {
  test('given storage refuses writes, when the tab resubscribes, then its dismissal still holds', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    vi.spyOn(host.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    const stop = app.subscribe(store)
    await clock.waitForResponse()
    store.dismiss()

    stop()
    app.subscribe(store)
    await clock.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismissed',
    })
  })
})

describe('dismissing for every tab', () => {
  test("given another tab dismissed the prompt level, then it holds here until this tab's own urgent level", async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()
    await clock.runFor(12 * HOUR)
    expect(store.getState().attention).toBe('prompt')

    host.otherTabSets(
      DISMISSAL_KEY,
      JSON.stringify({ dismissedAt: Date.now() }),
    )

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismissed',
    })
    await clock.runFor(10 * HOUR)
    expect(store.getState().attention).toBe('passive')
    await clock.runFor(2 * HOUR)
    expect(store.getState().attention).toBe('urgent')
  })
})

describe('clearing and blocking storage', () => {
  test('given another tab clears storage, then this tab prompts again too', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()
    store.dismiss()
    expect(store.getState().attention).toBe('passive')

    host.storageEvent(null)

    expect(store.getState().attention).toBe('prompt')
  })

  test('given storage was cleared while this tab was not subscribed, when it resubscribes, then it prompts again', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    const stop = app.subscribe(store)
    await clock.waitForResponse()
    expect(store.dismiss()).toBe(true)
    stop()

    host.localStorage.clear()
    app.subscribe(store)
    await clock.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'prompt',
      reason: 'outdated',
    })
  })

  test('given localStorage is blocked, when the user dismisses, then the dismissal holds in this tab', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    vi.spyOn(host.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()

    expect(store.dismiss()).toBe(true)
    await app.poll()

    expect(store.getState().attention).toBe('passive')
  })

  test('given a write failed and an older dismissal is in storage, then the newer dismissal is not overridden', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    host.localStorage.setItem(
      DISMISSAL_KEY,
      JSON.stringify({ dismissedAt: Date.now() - 2 * HOUR }),
    )
    vi.spyOn(host.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    app.subscribe(store)
    await clock.waitForResponse()

    expect(store.dismiss()).toBe(true)
    await app.poll()

    expect(store.getState().attention).toBe('passive')
  })
})
