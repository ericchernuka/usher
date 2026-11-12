import { vi } from 'vitest'
import { connectPrompt } from '../src/index'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { describe, expect, newer, older, test } from './fixtures'

describe('adapters that misbehave', () => {
  test('given show() dismisses synchronously, then hide() waits for show() to return', async ({
    app,
    clock,
  }) => {
    clock.setSystemTime('2026-11-12T04:00:00Z')
    server.use(serveBuild(newer))
    const log: string[] = []
    const store = app.create()
    app.track(
      connectPrompt(store, {
        show: p => {
          log.push(`show-start:${p.attention}`)
          p.dismiss()
          log.push('show-end')
        },
        hide: () => log.push('hide'),
      }),
    )
    await clock.waitForResponse()

    expect(log).toEqual(['show-start:prompt', 'show-end', 'hide'])
    expect(store.getState().attention).toBe('passive')
  })

  test('given show() throws at first, then connecting does not throw and the prompt appears once the library is ready', async ({
    app,
    clock,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(older))
    const shows: string[] = []
    let ready = false
    const store = app.create()
    app.track(
      connectPrompt(store, {
        show: p => {
          if (!ready) {
            throw new Error('toast lib not ready')
          }

          shows.push(p.attention)
        },
        hide: () => {},
      }),
    )
    await clock.waitForResponse()
    expect(shows).toEqual([])

    ready = true
    server.use(
      serveBuild({ ...older, forceUpdateBefore: '2026-11-12T00:00:00Z' }),
    )
    await app.poll()

    expect(shows).toEqual(['urgent'])
  })

  test('given show() throws on an update, when the next change arrives, then the prompt is retried', async ({
    app,
    clock,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(newer))
    const shows: string[] = []
    let failNext = false
    app.track(
      connectPrompt(app.create(), {
        minAttention: 'passive',
        show: p => {
          if (failNext) {
            throw new Error('toast library not ready')
          }

          shows.push(`${p.attention}:${p.reason}`)
        },
        hide: () => {},
      }),
    )
    await clock.waitForResponse()
    failNext = true
    server.use(serveBuild(older))
    await app.poll()

    failNext = false
    server.use(serveBuild({ ...older, version: 'older-still' }))
    await app.poll()

    expect(shows).toEqual(['passive:new-build', 'urgent:rollback'])
  })
})
