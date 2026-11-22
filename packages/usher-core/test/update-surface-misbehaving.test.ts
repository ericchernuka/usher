import { vi } from 'vitest'
import { connectUpdateSurface } from '../src/index'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { DISMISSAL_KEY, describe, expect, newer, older, test } from './fixtures'

describe('surfaces that misbehave', () => {
  test('given show() closes synchronously, then hide() waits for show() to return', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const log: string[] = []
    const store = app.create()
    app.track(
      connectUpdateSurface(store, {
        show: shown => {
          log.push(`show-start:${shown.attention}`)
          shown.close()
          log.push('show-end')
        },
        hide: () => log.push('hide'),
      }),
    )
    await tab.waitForResponse()

    expect(log).toEqual(['show-start:prompt', 'show-end', 'hide'])
    expect(store.state.get().attention).toBe('passive')
  })

  test('given show() throws at first, then connecting does not throw and the surface appears once the library is ready', async ({
    app,
    tab,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(older))
    const shows: string[] = []
    let ready = false
    const store = app.create()
    app.track(
      connectUpdateSurface(store, {
        show: shown => {
          if (!ready) {
            throw new Error('toast lib not ready')
          }

          shows.push(shown.attention)
        },
        hide: () => {},
      }),
    )
    await tab.waitForResponse()
    expect(shows).toEqual([])

    ready = true
    server.use(
      serveBuild({
        ...older,
        buildTime: '2026-11-11T15:30:00.000Z',
        forceUpdateBuiltBefore: '2026-11-11T15:30:00.000Z',
      }),
    )
    await app.poll()

    expect(shows).toEqual(['urgent'])
  })

  test('given the first show() opens its UI and then throws, then hide() removes it', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(newer))
    const log: string[] = []
    app.track(
      connectUpdateSurface(app.create(), {
        show: shown => {
          log.push(`show:${shown.attention}`)
          throw new Error('toast library threw after opening')
        },
        hide: () => log.push('hide'),
      }),
    )
    await tab.waitForResponse()

    expect(log).toEqual(['show:prompt', 'hide'])
  })

  test('given show() throws on an update, then the stale UI is hidden and the next change retries', async ({
    app,
    tab,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(newer))
    const log: string[] = []
    let failNext = false
    app.track(
      connectUpdateSurface(app.create(), {
        minAttention: 'passive',
        show: shown => {
          if (failNext) {
            throw new Error('toast library not ready')
          }

          log.push(`${shown.attention}:${shown.reason}`)
        },
        hide: () => log.push('hide'),
      }),
    )
    await tab.waitForResponse()
    failNext = true
    server.use(serveBuild(older))
    await app.poll()

    failNext = false
    server.use(serveBuild({ ...older, version: 'older-still' }))
    await app.poll()

    expect(log).toEqual(['passive:outdated', 'hide', 'urgent:rollback'])
  })

  test('given show() throws and the cleanup hide() reports a close, then the prompt is not dismissed, and the retry shows the latest build', async ({
    app,
    tab,
  }) => {
    tab.setSystemTime('2026-11-12T04:00:00Z')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(newer))
    const store = app.create()
    const shown: Array<string | undefined> = []
    let failed: { close: () => void } | undefined
    let ready = false

    app.track(
      connectUpdateSurface(store, {
        show: notice => {
          if (!ready) {
            failed = notice

            throw new Error('toast library threw after opening')
          }

          shown.push(notice.latest.version)
        },
        hide: () => failed?.close(),
      }),
    )
    await tab.waitForResponse()

    expect(store.state.get()).toMatchObject({
      attention: 'prompt',
      reason: 'outdated',
    })
    expect(tab.storage.getItem(DISMISSAL_KEY)).toBeNull()

    ready = true
    server.use(serveBuild({ ...newer, version: 'ccc' }))
    await app.poll()

    expect(shown).toEqual(['ccc'])
  })
})
