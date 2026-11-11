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
    server.use(serveBuild(older))
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
    await clock.settle()

    expect(log).toEqual(['show-start:urgent', 'show-end', 'hide'])
    expect(store.getState().attention).toBe('passive')
  })

  test('given an adapter that dismisses in show() against an app that always vetoes, then it stops after a few passes', async ({
    app,
    clock,
  }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server.use(serveBuild(older))
    let shows = 0

    const store = app.create({
      onAttentionChange: (_attention, details) => {
        if (details.reason === 'dismiss') {
          details.cancel()
        }
      },
    })

    app.track(
      connectPrompt(store, {
        show: p => {
          shows++
          p.dismiss()
        },
        hide: () => {},
      }),
    )
    await clock.settle()

    expect(shows).toBeLessThanOrEqual(5)
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
    await clock.settle()
    expect(shows).toEqual([])

    ready = true
    store.dismiss() // urgent -> passive; the 30 min snooze later expires -> urgent again
    await clock.runFor(31 * 60_000)

    expect(shows).toEqual(['urgent']) // not stuck as "shown" from the failed attempt
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
    await clock.settle()
    failNext = true
    server.use(serveBuild(older))
    await app.poll() // passive -> urgent: show() throws

    failNext = false
    server.use(serveBuild({ ...older, version: 'older-still' }))
    await app.poll()

    expect(shows).toEqual(['passive:new-build', 'urgent:rollback'])
  })
})
