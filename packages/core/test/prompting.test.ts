import { connectPrompt, defaultCopy, type Prompt } from '../src/index'
import { fakeAdapter } from './fake-adapter'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  SNOOZE_KEY,
  current,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

describe('showing and hiding', () => {
  test('given a rollback, then the prompt is shown once per change under a stable id, and hidden when caught up', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const ui = fakeAdapter()
    app.track(connectPrompt(app.create(), ui.adapter))
    await clock.settle()

    expect(ui.log).toEqual(['show:urgent'])
    expect(ui.open.id).toBe('app-update')

    await app.poll() // nothing changed: no duplicate show
    expect(ui.log).toEqual(['show:urgent'])

    server.use(serveBuild(current))
    await app.poll()

    expect(ui.log).toEqual(['show:urgent', 'hide'])
  })

  test('given a fix ships for a rollback, when the prompt is already up, then it is not shown again', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const shows: string[] = []
    app.track(
      connectPrompt(app.create(), {
        show: p => shows.push(`${p.attention}:${p.latest.version}`),
        hide: () => {},
      }),
    )
    await clock.settle()

    server.use(serveBuild({ ...older, version: 'older-still' }))
    await app.poll()

    expect(shows).toEqual(['urgent:old']) // same level and reason: not news
  })

  test('given the prompt is up, when the app disconnects, then it hides and polling stops', async ({
    app,
    clock,
    requests,
  }) => {
    server.use(serveBuild(older))
    const ui = fakeAdapter()
    const disconnect = connectPrompt(app.create(), ui.adapter)
    await clock.settle()
    disconnect()
    const checks = requests.length
    await app.poll()

    expect(ui.log).toEqual(['show:urgent', 'hide'])
    expect(requests).toHaveLength(checks)
  })

  test("given refresh is wired to the toast's action, then it follows the store's reload rules", async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    const removeBlocker = store.addReloadBlocker(() => true)
    const ui = fakeAdapter()
    app.track(connectPrompt(store, ui.adapter))
    await clock.settle()

    await ui.open.refresh()
    expect(host.navigations).toEqual([])

    removeBlocker()
    await ui.open.refresh()
    expect(host.navigations).toEqual([
      { type: 'reload', url: host.location.href },
    ])
  })
})

describe('closing the prompt', () => {
  test("given the user closes the toast, then the update is snoozed and a stale handle's second close is ignored", async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    const ui = fakeAdapter()
    app.track(connectPrompt(store, ui.adapter))
    await clock.settle()
    const handle = ui.open

    handle.dismiss()

    expect(store.getState().attention).toBe('passive')
    expect(ui.log).toEqual(['show:urgent', 'hide'])
    handle.dismiss() // libraries often fire onClose twice
    expect(ui.log).toEqual(['show:urgent', 'hide'])
  })

  test('given the library fires onClose for our own hide, then the update is not treated as dismissed', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    const store = app.create()
    let handle: Prompt | undefined
    const ui = fakeAdapter()
    app.track(
      connectPrompt(store, {
        show: p => {
          handle = p
          ui.adapter.show(p)
        },
        hide: () => {
          ui.adapter.hide()
          handle?.dismiss() // e.g. Base UI calls onClose on programmatic close
        },
      }),
    )
    await clock.settle()

    server.use(serveBuild(current))
    await app.poll()

    expect(store.getState().attention).toBe('none')
    expect(host.localStorage.getItem(SNOOZE_KEY)).toBeNull()
  })

  test('given the app vetoes the dismissal, when the user closes the toast, then it is shown again', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))

    const store = app.create({
      onAttentionChange: (_attention, details) => {
        if (details.reason === 'dismiss' && details.previous === 'urgent') {
          details.cancel()
        }
      },
    })

    const ui = fakeAdapter()
    app.track(connectPrompt(store, ui.adapter))
    await clock.settle()

    ui.open.dismiss()

    expect(ui.log).toEqual(['show:urgent', 'show:urgent'])
    expect(store.getState().attention).toBe('urgent')
  })

  test('given an urgent prompt (25 h old build), when the user closes it, then it hides once and is not re-shown as a prompt', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T16:00:00Z') // expired and stale at once
    const ui = fakeAdapter()
    app.track(connectPrompt(app.create(), ui.adapter))
    await clock.settle()

    ui.open.dismiss()
    await app.poll()

    expect(ui.log).toEqual(['show:urgent', 'hide'])
  })

  test('given a passive banner, when the user closes it, then it stays closed until the state changes', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    const ui = fakeAdapter('passive')
    app.track(connectPrompt(app.create(), ui.adapter))
    await clock.settle()
    expect(ui.log).toEqual(['show:passive'])

    ui.open.dismiss()
    await app.poll()
    expect(ui.log).toEqual(['show:passive', 'hide'])

    server.use(serveBuild(older)) // escalates
    await app.poll()

    expect(ui.log).toEqual(['show:passive', 'hide', 'show:urgent'])
  })

  test('given a banner at passive and a 14 h old build, when the user closes the prompt level, then the banner is not re-shown as passive', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T05:00:00Z') // prompt:stale
    const ui = fakeAdapter('passive')
    app.track(connectPrompt(app.create(), ui.adapter))
    await clock.settle()

    ui.open.dismiss()
    await app.poll()

    expect(ui.log).toEqual(['show:prompt', 'hide'])
  })
})

describe('default copy', () => {
  test.for([
    {
      attention: 'prompt',
      reason: 'stale',
      description: /ready/,
      action: 'Refresh',
    },
    {
      attention: 'urgent',
      reason: 'expired',
      description: /old version/,
      action: 'Refresh now',
    },
    {
      attention: 'urgent',
      reason: 'rollback',
      description: /known issue/,
      action: 'Refresh now',
    },
    {
      attention: 'urgent',
      reason: 'forced',
      description: /known issue/,
      action: 'Refresh now',
    },
  ] as const)(
    'given $attention:$reason, then the wording fits',
    ({ attention, reason, description, action }) => {
      const copy = defaultCopy({ attention, reason })

      expect(copy.description).toMatch(description)
      expect(copy.action).toBe(action)
    },
  )
})
