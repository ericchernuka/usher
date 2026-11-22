import { Toast } from '@base-ui/react/toast'
import { useSyncExternalStore } from 'react'
import { render } from 'vitest-browser-react'
import { configure } from 'vitest-browser-react/pure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectUpdateSurface,
  createAppUpdates as createCoreUpdates,
  type AppUpdates,
  type RefreshBlocker,
  type UpdateNotice,
} from '@rndsqr/usher-core'
import { useRefreshBlocker, useRefreshing, useUpdateState } from '../src/index'
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
      const { attention } = useUpdateState(updates)

      return attention === 'none' ? null : (
        <button
          type="button"
          aria-label="Dismiss update"
          data-attention={attention}
          onClick={updates.dismiss}
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
        updates.subscribe,
        () => updates.getState().attention,
      )

      const deferred = useUpdateState(updates).attention
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
      useRefreshBlocker(updates, dirty)

      return null
    }

    const view = await render(<Form dirty />)
    expect(await updates.refresh()).toBe('blocked')
    expect(navigations).toEqual([])
    await view.rerender(<Form dirty={false} />)
    expect(await updates.refresh()).toBe('reloading')
    expect(navigations).toHaveLength(1)
    await view.rerender(<Form dirty />)
    await view.unmount()
    expect(await updates.refresh()).toBe('reloading')
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
      useRefreshBlocker(updates, blocker)

      return null
    }

    const view = await render(<Form />)
    expect(await updates.refresh()).toBe('blocked')
    expect(navigations).toEqual([])
    expect(blocker).toHaveBeenCalledWith()

    blocking = false
    expect(await updates.refresh()).toBe('reloading')
    expect(navigations).toHaveLength(1)
    await view.unmount()
  })

  it('given an inline function, then re-rendering keeps one registration that calls the latest function', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdates()
    const add = vi.spyOn(updates, 'addRefreshBlocker')

    function Form({ dirty }: { dirty: boolean }) {
      useRefreshBlocker(updates, () => dirty)

      return null
    }

    const view = await render(<Form dirty />)
    const registrations = add.mock.calls.length
    await view.rerender(<Form dirty />)
    expect(add).toHaveBeenCalledTimes(registrations)
    expect(await updates.refresh()).toBe('blocked')

    await view.rerender(<Form dirty={false} />)
    expect(add).toHaveBeenCalledTimes(registrations)
    expect(await updates.refresh()).toBe('reloading')
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
      const refreshing = useRefreshing(updates)

      return (
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void updates.refresh()}
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

const TOAST_ID = 'app-update'

function copyFor({ attention, reason }: UpdateNotice) {
  if (reason === 'rollback' || reason === 'forced') {
    return {
      title: 'Please refresh',
      description: 'This version has a known issue. Refresh to get the fix.',
      action: 'Refresh now',
    }
  }

  if (attention === 'urgent') {
    return {
      title: 'Please refresh',
      description: "You're on an old version of the app. Refresh to update.",
      action: 'Refresh now',
    }
  }

  return {
    title: 'A new version is available',
    description: "Refresh when you're ready.",
    action: 'Refresh',
  }
}

function connectBaseUIToast(
  appUpdates: AppUpdates,
  toastManager: ReturnType<typeof Toast.createToastManager>,
) {
  return connectUpdateSurface(appUpdates, {
    show(notice) {
      const copy = copyFor(notice)
      toastManager.add({
        id: TOAST_ID,
        type: 'app-update',
        timeout: 0,
        priority: notice.attention === 'urgent' ? 'high' : 'low',
        title: copy.title,
        description: copy.description,
        actionProps: {
          children: copy.action,
          onClick: () => notice.refresh(),
        },
        onClose: () => notice.close(),
      })
    },
    hide: () => toastManager.close(TOAST_ID),
  })
}

function Toasts() {
  const { toasts, close } = Toast.useToastManager()

  return (
    <>
      {toasts
        .filter(toast => toast.transitionStatus !== 'ending')
        .map(toast => (
          <button
            type="button"
            key={toast.id}
            data-type={toast.type}
            onClick={() => close(toast.id)}
          >
            {toast.title}
          </button>
        ))}
    </>
  )
}

async function setup(updates: AppUpdates) {
  const toastManager = Toast.createToastManager()
  const disconnect = connectBaseUIToast(updates, toastManager)

  const view = await render(
    <Toast.Provider toastManager={toastManager}>
      <Toasts />
    </Toast.Provider>,
  )

  const toast = view.getByRole('button')

  return { ...view, toast, disconnect }
}

describe('Base UI recipe', () => {
  it('shows the toast outside React and dismisses on close', async () => {
    vi.setSystemTime(new Date('2026-11-12T04:00:00Z'))
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          ...older,
          version: 'new',
          commitTime: '2026-11-12T00:00:00Z',
        }),
      ),
    )
    const updates = createAppUpdates()
    const { toast, unmount, disconnect } = await setup(updates)
    await expect.element(toast).toHaveTextContent('A new version is available')

    await toast.click()
    await vi.waitFor(() => expect(updates.getState().attention).toBe('passive'))
    await expect.element(toast).not.toBeInTheDocument()
    disconnect()
    await unmount()
  })
})
