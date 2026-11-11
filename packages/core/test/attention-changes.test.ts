import { vi } from 'vitest'
import type { Attention, AttentionChangeReason } from '../src/index'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import {
  HOUR as H,
  SNOOZE_KEY,
  current,
  describe,
  expect,
  newer,
  older,
  test,
} from './fixtures'

describe('being told about changes', () => {
  test('given a deploy, a rollback, a dismissal and a fix, then each change is reported with its reason and previous level', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    const calls: Array<[Attention, AttentionChangeReason, Attention]> = []

    const store = app.create({
      onAttentionChange: (attention, details) =>
        calls.push([attention, details.reason, details.previous]),
    })

    app.subscribe(store)
    await clock.settle()

    server.use(serveBuild(older))
    await app.poll()
    store.dismiss()
    server.use(serveBuild(current))
    await app.poll()

    expect(calls).toEqual([
      ['passive', 'new-build', 'none'],
      ['urgent', 'rollback', 'passive'],
      ['passive', 'dismiss', 'urgent'],
      ['none', 'caught-up', 'passive'],
    ])
  })

  test('given an expired build, when a rollback appears, then the change of reason is reported and cannot be canceled', async ({
    app,
    clock,
  }) => {
    const seen: string[] = []
    server.use(serveBuild(newer))
    app.subscribe(
      app.create({
        onAttentionChange: (attention, details) =>
          seen.push(
            `${details.previous}->${attention}:${details.reason}:${details.cancelable}`,
          ),
      }),
    )
    await clock.settle()
    await clock.runFor(24 * H)
    server.use(serveBuild(older))
    await clock.runFor(5 * 60_000)

    expect(seen.at(-1)).toBe('urgent->urgent:rollback:false')
  })
})

describe('vetoing a raise', () => {
  test('given the app cancels a raise, when the next check lands and it allows it, then the raise is offered again, not on every input', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))
    let offers = 0
    let veto = true

    const store = app.create({
      onAttentionChange: (attention, details) => {
        if (attention !== 'urgent') {
          return
        }

        offers++

        if (veto) {
          details.cancel()
        }
      },
    })

    app.subscribe(store)
    await clock.settle()
    expect(store.getState().attention).toBe('none') // canceled: previous attention kept

    host.setVisibility('visible')
    host.storageEvent('other')
    expect(offers).toBe(1)

    veto = false
    await app.poll()

    expect(offers).toBe(2)
    expect(store.getState()).toMatchObject({
      attention: 'urgent',
      reason: 'rollback',
    })
  })

  test('given the app vetoes urgent for a tab at prompt, when the user dismisses, then urgent is still not published unasked', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(newer))
    clock.setSystemTime('2026-11-12T04:00:00Z') // 13 h: prompt:stale
    const offered: string[] = []

    const store = app.create({
      onAttentionChange: (attention, details) => {
        offered.push(`${attention}:${details.reason}`)

        if (attention === 'urgent') {
          details.cancel()
        }
      },
    })

    app.subscribe(store)
    await clock.settle()
    server.use(serveBuild(older)) // a rollback: urgent wanted, vetoed
    await app.poll()
    expect(store.getState().attention).toBe('prompt')

    store.dismiss()

    expect(store.getState().attention).not.toBe('urgent')
    expect(offered).toContain('urgent:rollback')
  })

  test('given a vetoed raise, when the user is busy and later idle, then the state reads declined, never a stuck waiting', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(newer))

    const store = app.create({
      idleFor: '5s',
      onAttentionChange: (attention, details) =>
        attention !== 'passive' && details.cancel(),
    })

    app.subscribe(store)
    await clock.settle()
    await clock.runFor(12 * H)
    expect(store.getState().reason).toBe('declined')

    host.keydown()
    host.setVisibility('visible') // re-evaluate while busy
    await clock.runFor(10_000)

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'declined',
    })
  })

  test('given a raise was published as waiting, when the app starts vetoing, then it becomes declined once idle', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(newer))
    let veto = false

    const store = app.create({
      idleFor: '5s',
      onAttentionChange: (attention, details) =>
        veto && attention !== 'passive' && details.cancel(),
    })

    app.subscribe(store)
    await clock.settle()
    await clock.runFor(11 * H - 2_000) // the build is 1 h from the prompt level
    host.keydown()
    await clock.runFor(3_000) // the prompt level starts while the user is busy
    expect(store.getState().reason).toBe('waiting')

    veto = true
    await clock.runFor(10_000)

    expect(store.getState()).toMatchObject({
      attention: 'passive',
      reason: 'declined',
    })
  })
})

describe('what cannot be vetoed or reentered', () => {
  test('given the app cancels everything, then a lowering still happens (it is a fact)', async ({
    app,
    clock,
  }) => {
    server.use(serveBuild(older))

    const store = app.create({
      onAttentionChange: (_attention, details) => {
        if (details.cancelable && details.previous === 'urgent') {
          details.cancel()
        }
      },
    })

    app.subscribe(store)
    await clock.settle()
    expect(store.getState().attention).toBe('urgent')

    server.use(serveBuild(current))
    await app.poll()

    expect(store.getState().attention).toBe('none')
  })

  test('given the app cancels the dismissal, then urgent stays and no snooze is written', async ({
    app,
    clock,
    host,
  }) => {
    server.use(serveBuild(older))

    const store = app.create({
      onAttentionChange: (_attention, details) => {
        if (details.reason === 'dismiss' && details.previous === 'urgent') {
          details.cancel()
        }
      },
    })

    app.subscribe(store)
    await clock.settle()

    expect(store.dismiss()).toBe(false)

    expect(store.getState().attention).toBe('urgent')
    expect(host.localStorage.getItem(SNOOZE_KEY)).toBeNull()
  })

  test('given dismiss() is called from inside onAttentionChange, then it is ignored so offers stay atomic', async ({
    app,
    clock,
  }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(serveBuild(older))
    let inner: boolean | undefined

    const store = app.create({
      onAttentionChange: attention => {
        if (attention === 'urgent') {
          inner = store.dismiss()
        }
      },
    })

    app.subscribe(store)
    await clock.settle()

    expect(inner).toBe(false)
    expect(store.getState().attention).toBe('urgent')
  })
})
