import { vi } from 'vitest'
import type { AppUpdates } from '../src/index'
import { describe, expect, test } from './fixtures'

describe('refreshing', () => {
  test('given two refreshes at once, then they share one reload', async ({
    app,
  }) => {
    const finished = Promise.withResolvers<void>()
    const reload = vi.fn<() => Promise<void>>(() => finished.promise)
    const store = app.create({ reload })

    const first = store.refresh()
    const second = store.refresh()
    finished.resolve()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(await first).toBe('reloading')
    expect(await second).toBe('reloading')
  })

  test('given a reload that takes time, then a refresh is in flight until the reload settles, whether it succeeds or throws, and subscribers hear both changes', async ({
    app,
    tab,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let reloaded = Promise.withResolvers<void>()
    const store = app.create({ reload: () => reloaded.promise })
    app.subscribe(store)
    await tab.waitForResponse()
    const heard: boolean[] = []
    app.subscribe(store, () => heard.push(store.isRefreshing()))

    expect(store.isRefreshing()).toBe(false)

    const succeeding = store.refresh()
    expect(store.isRefreshing()).toBe(true)
    reloaded.resolve()
    await succeeding
    expect(store.isRefreshing()).toBe(false)

    reloaded = Promise.withResolvers<void>()
    const throwing = store.refresh()
    expect(store.isRefreshing()).toBe(true)
    reloaded.reject(new Error('router failed'))
    await throwing

    expect(store.isRefreshing()).toBe(false)
    expect(heard).toEqual([true, false, true, false])
  })

  test('given a reload that asks for a refresh itself, then it finds one in flight and joins it', async ({
    app,
  }) => {
    const inFlight: boolean[] = []
    const joined: Array<ReturnType<AppUpdates['refresh']>> = []

    const reload = vi.fn<() => void>(() => {
      inFlight.push(store.isRefreshing())
      joined.push(store.refresh())
    })

    const store = app.create({ reload })

    expect(await store.refresh()).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(inFlight).toEqual([true])
    expect(await joined[0]).toBe('reloading')
    expect(store.isRefreshing()).toBe(false)
  })

  test('given the app supplies its own reload, then refresh delegates to it, and false or a throw means it was declined', async ({
    app,
    tab,
  }) => {
    const reload = vi.fn<() => Promise<boolean | undefined>>(async () => answer)
    let answer: boolean | undefined = false
    const store = app.create({ reload })

    expect(await store.refresh()).toBe('declined')
    expect(reload).toHaveBeenCalledWith()

    answer = undefined
    expect(await store.refresh()).toBe('reloading')
    expect(tab.reloads).toBe(0)

    vi.spyOn(console, 'error').mockImplementation(() => {})

    const throwing = app.create({
      reload: () => {
        throw new Error('router not ready')
      },
    })

    expect(await throwing.refresh()).toBe('declined')
  })

  test('given refresh blockers, then any one that returns true or throws vetoes, and removing it lifts the veto', async ({
    app,
    tab,
  }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = app.create()
    const removeForm = store.addRefreshBlocker(() => true)
    store.addRefreshBlocker(() => false)

    expect(await store.refresh()).toBe('blocked')

    removeForm()

    const removeBroken = store.addRefreshBlocker(() => {
      throw new Error('form state unavailable')
    })

    expect(await store.refresh()).toBe('blocked')
    expect(error).toHaveBeenCalledWith(
      '[usher] refresh blocker threw',
      expect.any(Error),
    )

    removeBroken()

    expect(await store.refresh()).toBe('reloading')
    expect(tab.reloads).toBe(1)
  })

  test('given a refresh blocker blocks, then no refresh is in flight and subscribers hear nothing', async ({
    app,
    tab,
  }) => {
    const store = app.create()
    app.subscribe(store)
    await tab.waitForResponse()
    const listener = vi.fn<() => void>()
    app.subscribe(store, listener)
    store.addRefreshBlocker(() => true)

    const blocked = store.refresh()

    expect(store.isRefreshing()).toBe(false)
    expect(await blocked).toBe('blocked')
    expect(listener).not.toHaveBeenCalled()
  })

  test('given several refresh blockers, then they run in the order added and stop at the first that blocks', async ({
    app,
  }) => {
    const calls: string[] = []
    const store = app.create()
    store.addRefreshBlocker(() => calls.push('first') < 0)
    store.addRefreshBlocker(() => calls.push('second') > 0)
    store.addRefreshBlocker(() => calls.push('third') > 0)

    expect(await store.refresh()).toBe('blocked')
    expect(calls).toEqual(['first', 'second'])
  })
})
