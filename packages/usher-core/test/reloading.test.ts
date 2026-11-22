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

    const first = store.refresh.run()
    const second = store.refresh.run()
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
    app.track(store.refresh.subscribe(() => heard.push(store.refresh.get())))

    expect(store.refresh.get()).toBe(false)

    const succeeding = store.refresh.run()
    expect(store.refresh.get()).toBe(true)
    reloaded.resolve()
    await succeeding
    expect(store.refresh.get()).toBe(false)

    reloaded = Promise.withResolvers<void>()
    const throwing = store.refresh.run()
    expect(store.refresh.get()).toBe(true)
    reloaded.reject(new Error('router failed'))
    await throwing

    expect(store.refresh.get()).toBe(false)
    expect(heard).toEqual([true, false, true, false])
  })

  test('given a reload that asks for a refresh itself, then it finds one in flight and joins it', async ({
    app,
  }) => {
    const inFlight: boolean[] = []
    const joined: Array<ReturnType<AppUpdates['refresh']['run']>> = []

    const reload = vi.fn<() => void>(() => {
      inFlight.push(store.refresh.get())
      joined.push(store.refresh.run())
    })

    const store = app.create({ reload })

    expect(await store.refresh.run()).toBe('reloading')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(inFlight).toEqual([true])
    expect(await joined[0]).toBe('reloading')
    expect(store.refresh.get()).toBe(false)
  })

  test('given the app supplies its own reload, then refresh delegates to it, and false or a throw means it was declined', async ({
    app,
    tab,
  }) => {
    const reload = vi.fn<() => Promise<boolean | undefined>>(async () => answer)
    let answer: boolean | undefined = false
    const store = app.create({ reload })

    expect(await store.refresh.run()).toBe('declined')
    expect(reload).toHaveBeenCalledWith()

    answer = undefined
    expect(await store.refresh.run()).toBe('reloading')
    expect(tab.reloads).toBe(0)

    vi.spyOn(console, 'error').mockImplementation(() => {})

    const throwing = app.create({
      reload: () => {
        throw new Error('router not ready')
      },
    })

    expect(await throwing.refresh.run()).toBe('declined')
  })

  test('given refresh blockers, then any one that returns true or throws vetoes, and removing it lifts the veto', async ({
    app,
    tab,
  }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = app.create()
    const removeForm = store.refresh.addBlocker(() => true)
    store.refresh.addBlocker(() => false)

    expect(await store.refresh.run()).toBe('blocked')

    removeForm()

    const removeBroken = store.refresh.addBlocker(() => {
      throw new Error('form state unavailable')
    })

    expect(await store.refresh.run()).toBe('blocked')
    expect(error).toHaveBeenCalledWith(
      '[usher] refresh blocker threw',
      expect.any(Error),
    )

    removeBroken()

    expect(await store.refresh.run()).toBe('reloading')
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
    app.track(store.refresh.subscribe(listener))
    store.refresh.addBlocker(() => true)

    const blocked = store.refresh.run()

    expect(store.refresh.get()).toBe(false)
    expect(await blocked).toBe('blocked')
    expect(listener).not.toHaveBeenCalled()
  })

  test('given several refresh blockers, then they run in the order added and stop at the first that blocks', async ({
    app,
  }) => {
    const calls: string[] = []
    const store = app.create()
    store.refresh.addBlocker(() => calls.push('first') < 0)
    store.refresh.addBlocker(() => calls.push('second') > 0)
    store.refresh.addBlocker(() => calls.push('third') > 0)

    expect(await store.refresh.run()).toBe('blocked')
    expect(calls).toEqual(['first', 'second'])
  })
})
