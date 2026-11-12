import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdates } from '../src/index'
import { captureNavigations, type NavigationRequest } from './navigation'

const running = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  buildTime: '2026-11-11T15:00:00.000Z',
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

  const appUpdates = createAppUpdates({
    running,
    versionUrl: '/version.json',
    reload: () =>
      router.navigate({
        href: window.location.href,
        reloadDocument: true,
        replace: true,
      }),
  })

  return { router, appUpdates }
}

describe('TanStack Router reload recipe', () => {
  it('a router blocker (as useBlocker registers) stops the reload, though the router does not report it', async () => {
    const { router, appUpdates } = setup()
    const blockerFn = vi.fn<() => boolean>(() => true)
    const unblock = router.history.block({ blockerFn })
    expect(await appUpdates.refresh()).toBe('reloading')
    expect(blockerFn).toHaveBeenCalled()
    expect(navigations).toEqual([])
    unblock()
  })

  it('without a blocker it replaces the document at the same URL', async () => {
    const { appUpdates } = setup()
    expect(await appUpdates.refresh()).toBe('reloading')
    expect(navigations).toEqual([{ type: 'replace', url: location.href }])
  })

  it('a refresh blocker stops the reload before the router hears of it, and says so', async () => {
    const { appUpdates } = setup()
    const unblock = appUpdates.addRefreshBlocker(() => true)
    expect(await appUpdates.refresh()).toBe('blocked')
    expect(navigations).toEqual([])
    unblock()
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
