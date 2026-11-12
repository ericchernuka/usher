import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdatesCore } from '../src/core'
import { captureNavigations, type NavigationRequest } from './navigation'

const current = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  builtAt: '2026-11-11T15:00:00.000Z',
}

let navigations: NavigationRequest[]

beforeEach(() => {
  navigations = captureNavigations()
})

function setup() {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/jobs'] }),
  })

  const appUpdates = createAppUpdatesCore({
    current,
    url: '/version.json',
    reload: async ({ href }) => {
      await router.navigate({ href, reloadDocument: true, replace: true })

      return false
    },
  })

  return { router, appUpdates }
}

describe('TanStack Router reload recipe', () => {
  it('a router blocker (as useBlocker registers) stops the reload', async () => {
    const { router, appUpdates } = setup()
    const blockerFn = vi.fn<() => boolean>(() => true)
    const unblock = router.history.block({ blockerFn })
    expect(await appUpdates.refresh()).toBe(false)
    expect(blockerFn).toHaveBeenCalled()
    expect(navigations).toEqual([])
    unblock()
  })

  it('without a blocker it replaces the document at the same URL', async () => {
    const { appUpdates } = setup()
    await appUpdates.refresh()
    expect(navigations).toEqual([{ type: 'replace', url: location.href }])
  })

  it("blockers that compare pathnames don't block reloads (current === next)", async () => {
    const { router, appUpdates } = setup()

    const blockerFn = vi.fn<
      NonNullable<Parameters<typeof router.history.block>[0]>['blockerFn']
    >(
      ({ currentLocation, nextLocation }) =>
        currentLocation.pathname !== nextLocation.pathname,
    )

    const unblock = router.history.block({ blockerFn })
    await appUpdates.refresh()
    expect(navigations).toHaveLength(1)
    unblock()
  })
})
