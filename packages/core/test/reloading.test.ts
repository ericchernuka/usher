import { vi } from 'vitest'
import type { ReloadDetails } from '../src/index'
import { server } from './mocks/node'
import { serveBuild } from './mocks/overrides'
import { describe, expect, newer, test } from './fixtures'

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
    expect(seen).toEqual([{ href: host.location.href }])

    answer = undefined
    expect(await store.refresh()).toBe(true)
    expect(host.navigations).toEqual([])

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
    store.addReloadBlocker(() => false)

    expect(await store.refresh()).toBe(false)

    removeForm()

    expect(await store.refresh()).toBe(true)
    expect(host.navigations).toEqual([
      { type: 'reload', url: host.location.href },
    ])
  })
})
