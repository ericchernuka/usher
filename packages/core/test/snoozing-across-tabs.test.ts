import { vi } from 'vitest'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  HOUR,
  MINUTE,
  SNOOZE_KEY,
  describe,
  expect,
  newer,
  older,
  rollbackAck,
  test,
} from './fixtures'

describe('reading what other tabs left in storage', () => {
  test.for([
    { name: 'not JSON', stored: '{oops' },
    { name: 'not an object', stored: '"snoozed"' },
    { name: 'an array', stored: '[1, 2]' },
    {
      name: 'a record with unreadable fields',
      stored: '{"promptAt":"soon","urgentAt":null}',
    },
  ])(
    'given storage holds $name, when the tab starts, then nothing is snoozed',
    async ({ stored }, { app, clock, host }) => {
      server.use(serveBuild(older))
      host.localStorage.setItem(SNOOZE_KEY, stored)
      const store = app.create()
      app.subscribe(store)
      await clock.settle()

      expect(store.getState()).toMatchObject({
        attention: 'urgent',
        reason: 'rollback',
      })
    },
  )

  test('given a record with one unreadable field, when the tab starts, then the readable ones still apply', async ({
    app,
    clock,
    host,
  }) => {
    // Build 25 h old: the urgent level is dismissed by `urgentAt`; `promptAt` is garbage.
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T16:00:00Z')
    host.localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ promptAt: 'yesterday', urgentAt: Date.now() }),
    )
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismiss',
    })
  })

  test('given a rollback acknowledgement next to a malformed one, when the tab starts, then the good one holds', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    host.localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({
        bad: {
          ...rollbackAck(Date.now() + 30 * MINUTE),
          other: { evidence: 'rollback', until: Date.now() + HOUR },
        },
      }),
    )
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismiss',
    })
  })

  test('given only malformed rollback acknowledgements, when the tab starts, then the rollback still raises urgent', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    host.localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({
        bad: { aaa: { evidence: ['rollback'], until: 'later' } },
      }),
    )
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
  })
})

describe('hearing from other tabs while running', () => {
  test('given another tab writes garbage, then this tab keeps its own snooze', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    store.dismiss()

    host.otherTabSets(SNOOZE_KEY, '{oops')

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismiss',
    })
  })

  test('given sessionStorage is cleared, then a localStorage snooze is not undone', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    store.dismiss()

    host.storageEventFor(null, host.sessionStorage) // another area's clear()

    expect(store.getState().attention).toBe('passive')
  })

  test('given this tab dismissed urgent, when another tab dismisses only the prompt, then both dismissals hold', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T16:00:00Z') // build 25 h old: expired
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    store.dismiss()

    host.otherTabSets(SNOOZE_KEY, JSON.stringify({ promptAt: Date.now() }))

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismiss',
    })
  })
})

describe('a snooze this tab could not save', () => {
  test('given storage refuses writes, when the tab resubscribes, then its dismissal still holds', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    vi.spyOn(host.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    const stop = app.subscribe(store)
    await clock.settle()
    store.dismiss()

    stop()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismiss',
    })
  })
})

describe('dismissing for every tab', () => {
  test('given a rollback, when the user dismisses it, then the acknowledgement is stored for this build and its evidence for 30 minutes', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })

    store.dismiss()

    expect(store.getState().attention).toBe('passive')
    const stored = JSON.parse(host.localStorage.getItem(SNOOZE_KEY) ?? 'null')
    expect(stored.bad).toEqual(rollbackAck(Date.now() + 30 * MINUTE))
  })

  test("given another tab dismissed the rollback, then this tab goes passive and the change is a fact it can't cancel", async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const seen: Array<[string, boolean]> = []

    const store = app.create({
      onAttentionChange: (attention, details) =>
        seen.push([`${attention}:${details.source}`, details.cancelable]),
    })

    app.subscribe(store)
    await clock.settle()

    host.otherTabSets(
      SNOOZE_KEY,
      JSON.stringify({ bad: rollbackAck(Date.now() + 30 * MINUTE) }),
    )

    expect(store.getState().attention).toBe('passive')
    expect(seen.at(-1)).toEqual(['passive:other-tab', false])
  })

  test("given another tab dismissed the prompt level, then it holds here until this tab's own urgent level", async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    await clock.runFor(12 * HOUR)
    expect(store.getState().attention).toBe('prompt')

    host.otherTabSets(SNOOZE_KEY, JSON.stringify({ promptAt: Date.now() })) // an older, already stale tab

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismiss',
    })
    await clock.runFor(10 * HOUR)
    expect(store.getState().attention).toBe('passive')
    await clock.runFor(2 * HOUR)
    expect(store.getState().reason).toBe('expired')
  })
})

describe('clearing and blocking storage', () => {
  test('given another tab clears storage, then this tab is un-snoozed too', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    app.subscribe(store)
    await clock.settle()
    store.dismiss()
    expect(store.getState().attention).toBe('passive')

    host.storageEvent(null) // localStorage.clear() elsewhere

    expect(store.getState().attention).toBe('urgent')
  })

  test('given storage was cleared while this tab was not subscribed, when it resubscribes, then it is un-snoozed', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    const stop = app.subscribe(store)
    await clock.settle()
    expect(store.dismiss()).toBe(true)
    stop()

    host.localStorage.clear()
    app.subscribe(store)
    await clock.settle()

    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
  })

  test('given localStorage is blocked, when the user dismisses, then the snooze holds in this tab', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    vi.spyOn(host.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.dismiss()).toBe(true)
    await app.poll()

    expect(store.getState().attention).toBe('passive') // still snoozed at the next check
  })

  test('given a write failed and an older snooze is in storage, then the newer dismissal is not overridden', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    host.localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ urgentAt: Date.now() - MINUTE }),
    )
    vi.spyOn(host.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    app.subscribe(store)
    await clock.settle()

    expect(store.dismiss()).toBe(true)
    await app.poll()

    expect(store.getState().attention).toBe('passive')
  })
})
