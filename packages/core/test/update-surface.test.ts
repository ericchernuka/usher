import { vi } from 'vitest'
import { connectUpdateSurface, type UpdateNotice } from '../src/index'
import { fakeSurface } from './fake-surface'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  DISMISSAL_KEY,
  running,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

describe('showing and hiding', () => {
  test('given an outdated build past the prompt threshold, then the surface is shown once per change and hidden when caught up', async ({
    app,
    clock,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const ui = fakeSurface()
    app.track(connectUpdateSurface(app.create(), ui.surface))
    await clock.waitForResponse()

    expect(ui.log).toEqual(['show:prompt'])

    await app.poll()
    expect(ui.log).toEqual(['show:prompt'])

    server.use(serveBuild(running))
    await app.poll()

    expect(ui.log).toEqual(['show:prompt', 'hide'])
  })

  test('given a fix ships for a rollback, when the surface is already up, then it is not shown again', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const shows: string[] = []
    app.track(
      connectUpdateSurface(app.create(), {
        show: p => shows.push(`${p.attention}:${p.latest.version}`),
        hide: () => {},
      }),
    )
    await clock.waitForResponse()

    server.use(serveBuild({ ...older, version: 'older-still' }))
    await app.poll()

    expect(shows).toEqual(['urgent:old'])
  })

  test('given the surface is up, when the app disconnects, then it hides and polling stops', async ({
    app,
    clock,
    requests,
  }) => {
    server.use(serveBuild(older))
    const ui = fakeSurface()
    const disconnect = connectUpdateSurface(app.create(), ui.surface)
    await clock.waitForResponse()
    disconnect()
    const checks = requests.length
    await app.poll()

    expect(ui.log).toEqual(['show:urgent', 'hide'])
    expect(requests).toHaveLength(checks)
  })

  test("given refresh is wired to the toast's action, then it follows the store's refresh rules", async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    const removeBlocker = store.addRefreshBlocker(() => true)
    const ui = fakeSurface()
    app.track(connectUpdateSurface(store, ui.surface))
    await clock.waitForResponse()

    await ui.open.refresh()
    expect(host.navigations).toEqual([])

    removeBlocker()
    await ui.open.refresh()
    expect(host.navigations).toEqual([
      { type: 'reload', url: host.location.href },
    ])
  })
})

describe('closing the surface', () => {
  test('given the user closes the toast, then the prompt is dismissed and a second close of the same notice is ignored', async ({
    app,
    clock,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    const ui = fakeSurface()
    app.track(connectUpdateSurface(store, ui.surface))
    await clock.waitForResponse()
    const notice = ui.open

    notice.close()

    expect(store.getState().attention).toBe('passive')
    expect(ui.log).toEqual(['show:prompt', 'hide'])
    notice.close()
    expect(ui.log).toEqual(['show:prompt', 'hide'])
  })

  test('given the library fires onClose for our own hide, then the update is not treated as dismissed', async ({
    app,
    clock,
    host,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const store = app.create()
    let notice: UpdateNotice | undefined
    const ui = fakeSurface()
    app.track(
      connectUpdateSurface(store, {
        show: p => {
          notice = p
          ui.surface.show(p)
        },
        hide: () => {
          ui.surface.hide()
          notice?.close()
        },
      }),
    )
    await clock.waitForResponse()

    server.use(serveBuild(running))
    await app.poll()

    expect(store.getState().attention).toBe('none')
    expect(host.localStorage.getItem(DISMISSAL_KEY)).toBeNull()
  })

  test('given an urgent notice, when the UI closes it anyway, then it is shown again as a new notice', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T16:00:00Z')
    const ui = fakeSurface()
    app.track(connectUpdateSurface(app.create(), ui.surface))
    await clock.waitForResponse()
    const first = ui.open

    first.close()

    expect(ui.log).toEqual(['show:urgent', 'show:urgent'])
    expect(ui.open).not.toBe(first)

    first.close()
    await app.poll()

    expect(ui.log).toEqual(['show:urgent', 'show:urgent'])
  })

  test('given a surface that closes every urgent notice inside show(), then the connection stops at the pass limit with one error', async ({
    app,
    clock,
  }) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(older))
    let shows = 0
    app.track(
      connectUpdateSurface(app.create(), {
        show: notice => {
          shows++
          notice.close()
        },
        hide: () => {},
      }),
    )

    await expect(clock.waitForResponse()).resolves.toBeUndefined()

    expect(shows).toBe(5)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('keeps re-triggering'),
      5,
    )
  })

  test('given a passive banner, when the user closes it, then it stays closed until the state changes', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    const ui = fakeSurface('passive')
    app.track(connectUpdateSurface(app.create(), ui.surface))
    await clock.waitForResponse()
    expect(ui.log).toEqual(['show:passive'])

    ui.open.close()
    await app.poll()
    expect(ui.log).toEqual(['show:passive', 'hide'])

    server.use(serveBuild(older))
    await app.poll()

    expect(ui.log).toEqual(['show:passive', 'hide', 'show:urgent'])
  })

  test('given a banner at passive and a 14 h old build, when the user closes the prompt level, then the banner is not re-shown as passive', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T05:00:00Z')
    const ui = fakeSurface('passive')
    app.track(connectUpdateSurface(app.create(), ui.surface))
    await clock.waitForResponse()

    ui.open.close()
    await app.poll()

    expect(ui.log).toEqual(['show:prompt', 'hide'])
  })
})
