import { vi } from 'vitest'
import { connectUpdateSurface } from '../src/index'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { describe, expect, newer, older, test } from './fixtures'

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
        show: p => {
          log.push(`show-start:${p.attention}`)
          p.close()
          log.push('show-end')
        },
        hide: () => log.push('hide'),
      }),
    )
    await tab.waitForResponse()

    expect(log).toEqual(['show-start:prompt', 'show-end', 'hide'])
    expect(store.getState().attention).toBe('passive')
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
        show: p => {
          if (!ready) {
            throw new Error('toast lib not ready')
          }

          shows.push(p.attention)
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
        show: p => {
          if (failNext) {
            throw new Error('toast library not ready')
          }

          log.push(`${p.attention}:${p.reason}`)
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
})
