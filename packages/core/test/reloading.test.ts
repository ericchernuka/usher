import { vi } from 'vitest'
import type { ReloadDetails, SubscribeToNavigation } from '../src/index'
import { fakeRouter } from './fake-router'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { describe, expect, newer, test } from './fixtures'

describe('reloading after a chunk fails to load', () => {
  test('given reloadOnChunkError is off, when a chunk fails, then the store leaves it to the app', ({
    app,
    host,
  }) => {
    app.subscribe(app.create({ reloadOnChunkError: false }))

    expect(host.preloadError()).toBe(false)
    expect(host.navigations).toEqual([])
  })

  test('given a blocker guards unsaved work, when a chunk fails, then the page is not reloaded', ({
    app,
    host,
  }) => {
    const store = app.create()
    app.subscribe(store)
    store.addReloadBlocker(details => details.reason === 'chunk-error')

    expect(host.preloadError()).toBe(false)
    expect(host.navigations).toEqual([])
    expect(host.sessionStorage.getItem('app-version:chunk-reload')).toBeNull() // not counted as a reload
  })

  test('given a refresh is already reloading the page, when a chunk fails, then no second reload starts', async ({
    app,
    host,
  }) => {
    const store = app.create({ reload: () => new Promise<void>(() => {}) })
    app.subscribe(store)
    void store.refresh()

    expect(host.preloadError()).toBe(false)
    expect(host.navigations).toEqual([])
  })

  test.for(['banana', 'Infinity', ''])(
    'given an unreadable reload marker %j in sessionStorage, when a chunk fails, then it reloads once',
    (marker, { app, host }) => {
      host.sessionStorage.setItem('app-version:chunk-reload', marker)
      app.subscribe(app.create())

      expect(host.preloadError()).toBe(true)
      expect(host.navigations).toHaveLength(1)
    },
  )
})

describe('reloading on navigation', () => {
  test('given the tab is up to date, when the user navigates, then the page is not reloaded', async ({
    app,
    clock,
    host,
  }) => {
    const router = fakeRouter()
    app.subscribe(
      app.create({ subscribeToNavigation: router.subscribeToNavigation }),
    )
    await clock.settle() // the default server still serves the running build

    router.navigate({ href: '/jobs' })
    await clock.settle()

    expect(host.navigations).toEqual([])
  })
})

describe('refreshing after a declined reload', () => {
  test('given the first reload was declined, when the user refreshes again, then it is attempted again', async ({
    app,
  }) => {
    server.use(serveBuild(newer))
    const reload = vi.fn<() => boolean>(() => false)
    const store = app.create({ reload })

    expect(await store.refresh()).toBe(false)
    expect(await store.refresh()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})

describe('the chunk-error reload guard', () => {
  test('given a reload just happened, then a second failure within 10s is left to the app, and the guard expires by time even after unsubscribing', async ({
    app,
    clock,
    host,
  }) => {
    const store = app.create()
    const stop = store.subscribe(() => {})
    expect(host.preloadError()).toBe(true) // the first failure reloads
    expect(host.navigations).toHaveLength(1)
    expect(host.preloadError()).toBe(false) // within 10 s: let the app see it

    stop() // unsubscribing early must not strand the guard
    await clock.runFor(11_000)
    app.subscribe(store)

    expect(host.preloadError()).toBe(true)
    expect(host.navigations).toHaveLength(2)
  })

  test('given sessionStorage is blocked, when a chunk fails, then the page is not reloaded (no loop guard available)', ({
    app,
    host,
  }) => {
    app.subscribe(app.create())
    vi.spyOn(host.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(host.preloadError()).toBe(false)
    expect(host.navigations).toEqual([])
  })

  test('given the app handles vite:preloadError itself, when a chunk fails, then the store leaves it alone', ({
    app,
    host,
  }) => {
    const seenByApp: boolean[] = []
    // Registered before the store subscribes, like an app's module-level listener.
    host.host.window.addEventListener('vite:preloadError', event => {
      seenByApp.push(true)
      event.preventDefault()
    })
    app.subscribe(app.create())

    expect(host.preloadError()).toBe(true) // claimed by the app
    expect(seenByApp).toEqual([true])
    expect(host.navigations).toEqual([]) // no reload on top of the app's own recovery
    expect(host.sessionStorage.getItem('app-version:chunk-reload')).toBeNull()
  })

  test('given an app listener that only observes, when a chunk fails, then both run and the store reloads', ({
    app,
    host,
  }) => {
    const seenByApp: boolean[] = []
    host.host.window.addEventListener(
      'vite:preloadError',
      () => void seenByApp.push(true),
    )
    app.subscribe(app.create())

    expect(host.preloadError()).toBe(true)
    expect(seenByApp).toEqual([true])
    expect(host.navigations).toHaveLength(1)
  })
})

describe('reloading on navigation (opt-in)', () => {
  test('given the tab is behind, when blockers allow it, then navigating reloads to the destination (or in place, for after-navigation routers)', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(newer))
    const router = fakeRouter()

    const store = app.create({
      subscribeToNavigation: router.subscribeToNavigation,
    })

    const removeBlocker = store.addReloadBlocker(
      details => details.reason === 'navigate',
    )

    app.subscribe(store)
    await clock.settle()

    router.navigate({ href: '/jobs' })
    await clock.settle()
    expect(host.navigations).toEqual([]) // blocked

    removeBlocker()
    router.navigate({ href: '/jobs' })
    await clock.settle()
    expect(host.navigations).toEqual([
      { type: 'push', url: new URL('/jobs', host.location.href).href },
    ])

    router.navigate()
    await clock.settle()
    expect(host.navigations.at(-1)).toEqual({
      type: 'reload',
      url: host.location.href,
    })
  })

  test('given a router subscription, then the store listens to navigation only while it is subscribed', ({
    app,
  }) => {
    const unsubscribeRouter = vi.fn<() => void>()

    const subscribeToNavigation = vi.fn<SubscribeToNavigation>(
      () => unsubscribeRouter,
    )

    const store = app.create({ subscribeToNavigation })
    expect(subscribeToNavigation).not.toHaveBeenCalled()

    const stop = store.subscribe(() => {})
    expect(subscribeToNavigation).toHaveBeenCalledTimes(1)

    stop()
    expect(unsubscribeRouter).toHaveBeenCalledTimes(1)
  })
})

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
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  test("given the app supplies its own reload, then refresh delegates to it, and false or a throw means it didn't happen", async ({
    app,
    host,
  }) => {
    const seen: ReloadDetails[] = []
    let answer: boolean | undefined = false

    const store = app.create({
      reload: async details => {
        seen.push(details)

        return answer
      },
    })

    expect(await store.refresh()).toBe(false)
    expect(seen).toEqual([{ reason: 'refresh', href: host.location.href }])

    answer = undefined // void: it happened
    expect(await store.refresh()).toBe(true)
    expect(host.navigations).toEqual([]) // the app's reload, not ours

    vi.spyOn(console, 'error').mockImplementation(() => {})

    const throwing = app.create({
      reload: () => {
        throw new Error('router not ready')
      },
    })

    expect(await throwing.refresh()).toBe(false)
  })

  test('given reload blockers, then any one vetoes and removing it lifts the veto', async ({
    app,
    host,
  }) => {
    const store = app.create()
    const removeForm = store.addReloadBlocker(() => true)
    store.addReloadBlocker(details => details.reason === 'navigate')

    expect(await store.refresh()).toBe(false)

    removeForm()

    expect(await store.refresh()).toBe(true) // the other blocker only guards navigation
    expect(host.navigations).toEqual([
      { type: 'reload', url: host.location.href },
    ])
  })
})
