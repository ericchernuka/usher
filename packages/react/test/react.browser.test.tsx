import { Toast } from '@base-ui/react/toast'
import { useSyncExternalStore } from 'react'
import { render } from 'vitest-browser-react'
import { configure } from 'vitest-browser-react/pure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectPrompt,
  PROMPT_ID,
  createAppUpdates as createCoreUpdates,
  defaultCopy,
  type AppUpdates,
  type RefreshBlocker,
} from '@app-version/core'
import { useAppUpdates, useRefreshBlocker } from '../src/index'
import { captureNavigations } from '../../core/test/navigation'
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

describe('useAppUpdates', () => {
  it('selects a slice and re-renders only when it changes', async () => {
    vi.setSystemTime(new Date('2026-11-12T04:00:00Z'))

    let latest = {
      ...older,
      version: 'new',
      commitTime: '2026-11-12T00:00:00Z',
    }

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Response.json(latest)),
    )
    const updates = createAppUpdates()
    let renders = 0

    function NavButton() {
      renders++
      const attention = useAppUpdates(updates, s => s.attention)

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

    const before = renders
    latest = { ...latest, version: 'newest' }
    vi.advanceTimersByTime(61_000)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() =>
      expect(updates.getState()).toMatchObject({
        latest: { version: 'newest' },
      }),
    )
    expect(renders).toBe(before)

    await button.click()
    await expect.element(button).toHaveAttribute('data-attention', 'passive')

    await view.unmount()
    const calls = vi.mocked(fetch).mock.calls.length
    vi.advanceTimersByTime(61_000)
    window.dispatchEvent(new Event('focus'))
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
  })
})

describe('useAppUpdates without a selector', () => {
  it('returns the whole state', async () => {
    const updates = createAppUpdates()

    function Reason() {
      const state = useAppUpdates(updates)

      return <output>{`${state.attention}:${state.reason}`}</output>
    }

    const view = await render(<Reason />)
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('urgent:rollback')
    await view.unmount()
  })
})

describe('useAppUpdates selector check', () => {
  it('warns once in dev when a selector returns a new object', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const updates = createAppUpdates()

    function Good() {
      useAppUpdates(updates, s => s.attention)

      return null
    }

    const ok = await render(<Good />)
    expect(error.mock.calls.some(([m]) => String(m).includes('selector'))).toBe(
      false,
    )
    await ok.unmount()

    function Worse() {
      useAppUpdates(updates, s => ({ a: s.attention }))

      return null
    }

    try {
      await (await render(<Worse />)).unmount()
    } catch {}

    expect(
      error.mock.calls.some(([m]) =>
        String(m).includes('[app-version] useAppUpdates selector'),
      ),
    ).toBe(true)
    error.mockRestore()
  })
})

describe('useAppUpdates deferral', () => {
  it('renders the new value at low priority: urgent pass keeps the old value, then catches up', async () => {
    const updates = createAppUpdates()
    const seen: Array<[urgent: string, deferred: string]> = []

    function Probe() {
      const urgent = useSyncExternalStore(
        updates.subscribe,
        () => updates.getState().attention,
      )

      const deferred = useAppUpdates(updates, s => s.attention)
      seen.push([urgent, deferred])

      return null
    }

    const { unmount } = await render(<Probe />)
    await tick()
    expect(seen.some(([u, d]) => u !== d)).toBe(true)
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
    expect(await updates.refresh()).toBe(false)
    expect(navigations).toEqual([])
    await view.rerender(<Form dirty={false} />)
    expect(await updates.refresh()).toBe(true)
    expect(navigations).toHaveLength(1)
    await view.rerender(<Form dirty />)
    await view.unmount()
    expect(await updates.refresh()).toBe(true)
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
    expect(await updates.refresh()).toBe(false)
    expect(navigations).toEqual([])
    expect(blocker).toHaveBeenCalledWith()

    blocking = false
    expect(await updates.refresh()).toBe(true)
    expect(navigations).toHaveLength(1)
    await view.unmount()
  })
})

function connectBaseUIToast(
  appUpdates: AppUpdates,
  toastManager: ReturnType<typeof Toast.createToastManager>,
) {
  return connectPrompt(appUpdates, {
    show: p =>
      toastManager.add({
        id: p.id,
        type: 'app-update',
        timeout: 0,
        priority: p.attention === 'urgent' ? 'high' : 'low',
        title: defaultCopy(p).title,
        description: defaultCopy(p).description,
        actionProps: {
          children: defaultCopy(p).action,
          onClick: () => p.refresh(),
        },
        onClose: () => p.dismiss(),
      }),
    hide: () => toastManager.close(PROMPT_ID),
  })
}

function Toasts() {
  const { toasts, close } = Toast.useToastManager()

  return (
    <>
      {toasts
        .filter(t => t.transitionStatus !== 'ending')
        .map(t => (
          <button
            type="button"
            key={t.id}
            data-type={t.type}
            onClick={() => close(t.id)}
          >
            {t.title}
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
