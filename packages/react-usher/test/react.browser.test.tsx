import { useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { render } from 'vitest-browser-react'
import { configure } from 'vitest-browser-react/pure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAppUpdates as createCoreUpdates,
  type RefreshBlocker,
} from '@ericchernuka/usher-core'
import {
  UpdateNotice,
  useUpdateNotice,
  useRefreshBlocker,
  useRefreshing,
  useUpdateState,
} from '../src/index'
import { createTestTab } from '@ericchernuka/usher-core/testing'
import { captureNavigations } from '../../usher-core/test/navigation'
import { runningBuild, versionUrl } from './build-info.stub'

configure({ reactStrictMode: true })

const createAppUpdates = () =>
  createCoreUpdates({ running: runningBuild, versionUrl })

const older = {
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
  buildTime: '2026-11-10T15:00:00.000Z',
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date('2026-11-11T16:00:00Z'))
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(older))),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useUpdateState', () => {
  it('reads the state, re-renders when it changes, and stops polling on unmount', async () => {
    vi.setSystemTime(new Date('2026-11-12T04:00:00Z'))

    const latest = {
      ...older,
      version: 'new',
      commitTime: '2026-11-12T00:00:00Z',
    }

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Response.json(latest)),
    )
    const updates = createAppUpdates()

    function NavButton() {
      const { attention } = useUpdateState(updates.state)

      return attention === 'none' ? null : (
        <button
          type="button"
          aria-label="Dismiss update"
          data-attention={attention}
          onClick={updates.state.dismiss}
        />
      )
    }

    const view = await render(<NavButton />)
    const button = view.getByRole('button')
    await expect.element(button).toHaveAttribute('data-attention', 'prompt')

    await button.click()
    await expect.element(button).toHaveAttribute('data-attention', 'passive')

    await view.unmount()
    const calls = vi.mocked(fetch).mock.calls.length
    vi.advanceTimersByTime(61_000)
    window.dispatchEvent(new Event('focus'))
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
  })
})

describe('useUpdateState deferral', () => {
  it('renders the new value at low priority: urgent pass keeps the old value, then catches up', async () => {
    const updates = createAppUpdates()
    const seen: Array<[urgent: string, deferred: string]> = []

    function Probe() {
      const urgent = useSyncExternalStore(
        updates.state.subscribe,
        () => updates.state.get().attention,
      )

      const deferred = useUpdateState(updates.state).attention
      seen.push([urgent, deferred])

      return null
    }

    const { unmount } = await render(<Probe />)
    await tick()
    expect(seen.some(([urgent, deferred]) => urgent !== deferred)).toBe(true)
    expect(seen.at(-1)).toEqual(['urgent', 'urgent'])
    await unmount()
  })
})

describe('useRefreshBlocker', () => {
  it('blocks refresh while mounted and blocking', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdates()

    function Form({ dirty }: { dirty: boolean }) {
      useRefreshBlocker(updates.refresh, dirty)

      return null
    }

    const view = await render(<Form dirty />)
    expect(await updates.refresh.run()).toBe('blocked')
    expect(navigations).toEqual([])
    await view.rerender(<Form dirty={false} />)
    expect(await updates.refresh.run()).toBe('reloading')
    expect(navigations).toHaveLength(1)
    await view.rerender(<Form dirty />)
    await view.unmount()
    expect(await updates.refresh.run()).toBe('reloading')
    expect(navigations).toHaveLength(2)
  })
})

describe('useRefreshBlocker with a function', () => {
  it('blocks only while the function returns true', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdates()
    let blocking = true
    const blocker = vi.fn<RefreshBlocker>(() => blocking)

    function Form() {
      useRefreshBlocker(updates.refresh, blocker)

      return null
    }

    const view = await render(<Form />)
    expect(await updates.refresh.run()).toBe('blocked')
    expect(navigations).toEqual([])
    expect(blocker).toHaveBeenCalledWith()

    blocking = false
    expect(await updates.refresh.run()).toBe('reloading')
    expect(navigations).toHaveLength(1)
    await view.unmount()
  })

  it('given an inline function, then re-rendering keeps one registration that calls the latest function', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdates()
    const add = vi.spyOn(updates.refresh, 'addBlocker')

    function Form({ dirty }: { dirty: boolean }) {
      useRefreshBlocker(updates.refresh, () => dirty)

      return null
    }

    const view = await render(<Form dirty />)
    const registrations = add.mock.calls.length
    await view.rerender(<Form dirty />)
    expect(add).toHaveBeenCalledTimes(registrations)
    expect(await updates.refresh.run()).toBe('blocked')

    await view.rerender(<Form dirty={false} />)
    expect(add).toHaveBeenCalledTimes(registrations)
    expect(await updates.refresh.run()).toBe('reloading')
    expect(navigations).toHaveLength(1)
    await view.unmount()
  })
})

describe('useRefreshing', () => {
  it('disables a refresh control while the reload runs, and enables it again when the reload settles', async () => {
    const reloaded = Promise.withResolvers<boolean>()

    const updates = createCoreUpdates({
      running: runningBuild,
      versionUrl,
      reload: () => reloaded.promise,
    })

    function RefreshButton() {
      const refreshing = useRefreshing(updates.refresh)

      return (
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void updates.refresh.run()}
        >
          Refresh
        </button>
      )
    }

    const view = await render(<RefreshButton />)
    const button = view.getByRole('button', { name: 'Refresh' })
    await expect.element(button).toBeEnabled()

    await button.click()
    await expect.element(button).toBeDisabled()

    reloaded.resolve(false)
    await expect.element(button).toBeEnabled()
    await view.unmount()
  })
})

describe('UpdateNotice', () => {
  const HOUR = 60 * 60 * 1000

  async function outdated(hours: number, served = older) {
    const tab = createTestTab()

    tab.deploy({
      ...served,
      version: 'new',
      commitTime: '2026-11-12T00:00:00Z',
      buildTime: new Date(tab.now()).toISOString(),
    })
    const reloaded = Promise.withResolvers<boolean>()

    const updates = createCoreUpdates(
      { running: runningBuild, versionUrl, reload: () => reloaded.promise },
      tab,
    )

    const view = await render(
      <UpdateNotice.Root
        updates={updates}
        minAttention="passive"
        announcement={notice => notice.reason}
      >
        {notice => (
          <>
            <p>{notice.reason}</p>
            <UpdateNotice.Refresh>Refresh</UpdateNotice.Refresh>
            <UpdateNotice.Close aria-label="Close" />
          </>
        )}
      </UpdateNotice.Root>,
    )

    await tab.advance(hours * HOUR)

    return { tab, updates, view, reloaded }
  }

  it('given a passive notice, then it is quiet and closes for this tab only', async () => {
    const { updates, view } = await outdated(1)
    const notice = view.getByText('outdated')
    await expect.element(notice).toBeVisible()
    await expect.element(view.getByRole('status')).toHaveTextContent('')

    await view.getByRole('button', { name: 'Close' }).click()
    await expect.element(notice).not.toBeInTheDocument()
    expect(updates.state.get().reason).toBe('outdated')
    await view.unmount()
  })

  it('marks a prompt for styling, and closing it dismisses the prompt', async () => {
    const { updates, view } = await outdated(13)
    const notice = view.getByRole('paragraph')
    await expect.element(notice).toBeVisible()
    expect(view.container.querySelector('[data-attention]')).toHaveAttribute(
      'data-attention',
      'prompt',
    )

    await view.getByRole('button', { name: 'Close' }).click()
    await expect.element(notice).not.toBeInTheDocument()
    expect(updates.state.get().reason).toBe('dismissed')
    await view.unmount()
  })

  it('gives urgent attention no close control, and disables refresh while the reload runs', async () => {
    const { view, reloaded } = await outdated(25)
    await expect.element(view.getByRole('alert')).toHaveTextContent('outdated')
    expect(view.container.querySelector('[data-attention]')).toHaveAttribute(
      'data-attention',
      'urgent',
    )
    expect(view.getByRole('button', { name: 'Close' }).query()).toBeNull()

    const refresh = view.getByRole('button', { name: 'Refresh' })
    await refresh.click()
    await expect.element(refresh).toBeDisabled()
    await expect.element(refresh).toHaveAttribute('data-refreshing')

    reloaded.resolve(false)
    await expect.element(refresh).toBeEnabled()
    await view.unmount()
  })

  it('given a component that renders its own banner, then the hook gives it the notice', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })

    const updates = createCoreUpdates(
      { running: runningBuild, versionUrl },
      tab,
    )

    function Banner() {
      const notice = useUpdateNotice(updates)

      return notice ? <p data-testid="banner">{notice.reason}</p> : null
    }

    const view = await render(<Banner />)
    await tab.advance(0)

    await expect
      .element(view.getByTestId('banner'))
      .toHaveTextContent('rollback')
    await view.unmount()
  })

  it('given a part has its own onClick, then it runs and the part still acts', async () => {
    const { updates, view } = await outdated(13)
    const clicked = vi.fn<() => void>()
    const run = vi.spyOn(updates.refresh, 'run')

    await view.rerender(
      <UpdateNotice.Root updates={updates} announcement={() => 'Update'}>
        {() => (
          <>
            <UpdateNotice.Refresh onClick={clicked}>
              Refresh
            </UpdateNotice.Refresh>
            <UpdateNotice.Close onClick={clicked}>Close</UpdateNotice.Close>
          </>
        )}
      </UpdateNotice.Root>,
    )

    await view.getByRole('button', { name: 'Refresh' }).click()
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)

    await view.getByRole('button', { name: 'Close' }).click()
    expect(clicked).toHaveBeenCalledTimes(2)
    expect(updates.state.get().reason).toBe('dismissed')
    await view.unmount()
  })

  it('given refresh has an action, then the action decides whether to refresh, and the button is disabled until it settles', async () => {
    const { updates, view } = await outdated(13)
    const confirmed = Promise.withResolvers<boolean>()
    const run = vi.spyOn(updates.refresh, 'run')

    await view.rerender(
      <UpdateNotice.Root updates={updates} announcement={() => 'Update'}>
        {() => (
          <UpdateNotice.Refresh
            action={async refresh => {
              if (await confirmed.promise) {
                await refresh()
              }
            }}
          >
            Refresh
          </UpdateNotice.Refresh>
        )}
      </UpdateNotice.Root>,
    )

    const button = view.getByRole('button', { name: 'Refresh' })
    await button.click()
    await expect.element(button).toBeDisabled()
    expect(run).not.toHaveBeenCalled()

    confirmed.resolve(false)
    await expect.element(button).toBeEnabled()
    expect(run).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('given refresh is passed disabled={false}, then it is still disabled while its action runs', async () => {
    const { updates, view } = await outdated(13)
    const working = Promise.withResolvers<void>()
    const action = vi.fn<() => Promise<void>>(() => working.promise)

    await view.rerender(
      <UpdateNotice.Root updates={updates} announcement={() => 'Update'}>
        {() => (
          <UpdateNotice.Refresh disabled={false} action={action}>
            Refresh
          </UpdateNotice.Refresh>
        )}
      </UpdateNotice.Root>,
    )

    const button = view.getByRole('button', { name: 'Refresh' })
    await button.click()
    await expect.element(button).toBeDisabled()

    working.resolve()
    await expect.element(button).toBeEnabled()
    expect(action).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('given an action discards a draft held in state and refreshes again, then the second refresh is not blocked', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })

    const updates = createCoreUpdates(
      { running: runningBuild, versionUrl },
      tab,
    )

    const outcomes: string[] = []

    function Editor() {
      const [dirty, setDirty] = useState(true)
      useRefreshBlocker(updates.refresh, dirty)

      return (
        <UpdateNotice.Root updates={updates} announcement={() => 'Update'}>
          {() => (
            <UpdateNotice.Refresh
              action={async refresh => {
                outcomes.push(await refresh())
                flushSync(() => setDirty(false))
                outcomes.push(await refresh())
              }}
            >
              Refresh
            </UpdateNotice.Refresh>
          )}
        </UpdateNotice.Root>
      )
    }

    const view = await render(<Editor />)
    await tab.advance(0)
    await view.getByRole('button', { name: 'Refresh' }).click()

    await expect.poll(() => outcomes).toEqual(['blocked', 'reloading'])
    await view.unmount()
  })

  it('given a part outside the root, then rendering fails naming the part', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(render(<UpdateNotice.Close />)).rejects.toThrow(
      /<UpdateNotice.Close> must be inside <UpdateNotice.Root>/,
    )
  })
})
