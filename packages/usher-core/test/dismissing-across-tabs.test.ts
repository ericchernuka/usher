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
    async ({ stored }, { app, tab }) => {
      tab.setSystemTime('2026-11-12T04:00:00Z')
      server.use(serveBuild(newer))
      tab.storage.setItem(DISMISSAL_KEY, stored)
      const store = app.create()
      app.subscribe(store)
      await tab.waitForResponse()

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
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    store.dismiss()

    tab.otherTabSets(DISMISSAL_KEY, '{oops')

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismissed',
    })
  })
})

describe('dismissing for every tab', () => {
  test("given another tab dismissed the prompt level, then it holds here until this tab's own urgent level", async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    await tab.runFor(12 * HOUR)
    expect(store.getState().attention).toBe('prompt')

    tab.otherTabSets(DISMISSAL_KEY, JSON.stringify({ dismissedAt: tab.now() }))

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismissed',
    })
    await tab.runFor(10 * HOUR)
    expect(store.getState().attention).toBe('passive')
    await tab.runFor(2 * HOUR)
    expect(store.getState().attention).toBe('urgent')
  })
})

describe('dismissals that do not apply here', () => {
  test('given another tab dismissed before this tab reached its prompt age, then this tab still prompts when it does', async ({
    app,
    tab,
  }) => {
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    await tab.runFor(10 * HOUR)

    tab.otherTabSets(DISMISSAL_KEY, JSON.stringify({ dismissedAt: tab.now() }))
    await tab.runFor(HOUR)

    expect(store.getState()).toMatchObject({
      attention: 'prompt',
      reason: 'outdated',
    })
  })

  test('given two apps on one origin with their own storage keys, then a dismissal in one does not quiet the other', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const billing = app.create({ storageKey: 'billing' })
    app.subscribe(billing)
    await tab.waitForResponse()

    tab.otherTabSets(DISMISSAL_KEY, JSON.stringify({ dismissedAt: tab.now() }))
    expect(billing.getState().attention).toBe('prompt')

    expect(billing.dismiss()).toBe(true)
    expect(tab.storage.getItem('billing:prompt-dismissal')).toBe(
      JSON.stringify({ dismissedAt: tab.now() }),
    )
  })
})

describe('clearing and blocking storage', () => {
  test('given another tab clears storage, then this tab prompts again too', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    store.dismiss()
    expect(store.getState().attention).toBe('passive')

    tab.otherTabClears()

    expect(store.getState().attention).toBe('prompt')
  })

  test('given storage was cleared while this tab was not subscribed, when it resubscribes, then it prompts again', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    const stop = app.subscribe(store)
    await tab.waitForResponse()
    expect(store.dismiss()).toBe(true)
    stop()

    tab.storage.clear()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'prompt',
      reason: 'outdated',
    })
  })

  test("given storage refuses writes and holds an older dismissal, then this tab's dismissal holds, also after it resubscribes", async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    tab.storage.setItem(
      DISMISSAL_KEY,
      JSON.stringify({ dismissedAt: tab.now() - 2 * HOUR }),
    )
    vi.spyOn(tab.storage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const store = app.create()
    const stop = app.subscribe(store)
    await tab.waitForResponse()
    expect(store.getState().attention).toBe('prompt')

    expect(store.dismiss()).toBe(true)
    stop()
    app.subscribe(store)
    await tab.waitForResponse()

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'dismissed',
    })
  })
})
