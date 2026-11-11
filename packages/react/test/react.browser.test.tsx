import { Toast } from '@base-ui/react/toast'
import { useSyncExternalStore } from 'react'
import { render } from 'vitest-browser-react'
import { configure } from 'vitest-browser-react/pure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectPrompt,
  createAppUpdates,
  defaultCopy,
  type AppUpdates,
} from '@app-version/core'
import { useAppUpdates, useReloadBlocker } from '../src/index'
import { captureNavigations } from './navigation'

configure({ reactStrictMode: true })

const older = {
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
  builtAt: '2026-11-10T15:00:00.000Z',
}

// Real time: only Date and performance are faked, so React's scheduler and fetch run normally.
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  vi.setSystemTime(new Date('2026-11-11T16:00:00Z')) // an hour after the stub build
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
    const updates = createAppUpdates({ idleFor: '0s' })
    let renders = 0

    function NavButton() {
      renders++
      const attention = useAppUpdates(updates, s => s.attention)

      return attention === 'none' ? null : (
        <button data-attention={attention} onClick={updates.dismiss} />
      )
    }

    const view = await render(<NavButton />)
    const button = view.getByRole('button')
    await expect.element(button).toHaveAttribute('data-attention', 'urgent')

    const before = renders
    window.dispatchEvent(new Event('focus')) // a poll that changes nothing
    await tick()
    expect(renders).toBe(before)

    await button.click()
    await expect.element(button).toHaveAttribute('data-attention', 'passive')

    await view.unmount()
    const calls = vi.mocked(fetch).mock.calls.length
    window.dispatchEvent(new Event('focus'))
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls) // last subscriber left: engine stopped
  })
})

describe('useAppUpdates without a selector', () => {
  it('returns the whole state', async () => {
    const updates = createAppUpdates({ idleFor: '0s' })

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
    const updates = createAppUpdates({ idleFor: '0s' })

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
      try {
        useAppUpdates(updates, s => ({ a: s.attention }))
      } catch {
        /* React may also throw on the resulting loop */
      }

      return null
    }

    try {
      await (await render(<Worse />)).unmount()
    } catch {
      /* infinite-loop guard from React */
    }

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
    const updates = createAppUpdates({ idleFor: '0s' })
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
    // Some render saw the store ahead of the deferred value, and the last one caught up.
    expect(seen.some(([u, d]) => u !== d)).toBe(true)
    expect(seen.at(-1)).toEqual(['urgent', 'urgent'])
    await unmount()
  })
})

describe('useReloadBlocker', () => {
  it('blocks refresh while mounted and blocking', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdates()

    function Form({ dirty }: { dirty: boolean }) {
      useReloadBlocker(updates, dirty)

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
    expect(await updates.refresh()).toBe(true) // unmount removed the blocker
    expect(navigations).toHaveLength(2)
  })
})

describe('useReloadBlocker with a function', () => {
  it('blocks only the reloads the function accepts', async () => {
    const navigations = captureNavigations()
    const updates = createAppUpdates()

    function Form() {
      useReloadBlocker(updates, d => d.reason === 'navigate')

      return null
    }

    const view = await render(<Form />)
    expect(await updates.refresh()).toBe(true) // a refresh isn't a navigation
    expect(navigations).toHaveLength(1)
    await view.unmount()
  })
})

// The README's Base UI recipe, verbatim, run against real Base UI.
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
        actionProps: { children: defaultCopy(p).action, onClick: p.refresh },
        onClose: p.dismiss,
      }),
    hide: () => toastManager.close('app-update'),
  })
}

describe('Base UI recipe', () => {
  function Toasts() {
    const { toasts, close } = Toast.useToastManager()

    return (
      <>
        {toasts
          .filter(t => t.transitionStatus !== 'ending') // closed, waiting on an exit animation
          .map(t => (
            <output key={t.id} data-type={t.type} onClick={() => close(t.id)}>
              {t.title}
            </output>
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

    const toast = view.getByRole('status')

    return { ...view, toast, disconnect }
  }

  it('shows the toast outside React and dismisses on close', async () => {
    const updates = createAppUpdates({ idleFor: '0s' })
    const { toast, unmount, disconnect } = await setup(updates)
    await expect.element(toast).toHaveTextContent('Please refresh')

    await toast.click()
    await vi.waitFor(() => expect(updates.getState().attention).toBe('passive'))
    await expect.element(toast).not.toBeInTheDocument()
    disconnect()
    await unmount()
  })

  it('brings the toast back when the app cancels the dismiss', async () => {
    const updates = createAppUpdates({
      idleFor: '0s',
      onAttentionChange: (_a, d) => {
        if (d.reason === 'dismiss' && d.previous === 'urgent') {
          d.cancel()
        }
      },
    })

    const { toast, unmount, disconnect } = await setup(updates)
    await expect.element(toast).toHaveTextContent('Please refresh')
    await toast.click()
    await tick()
    expect(updates.getState().attention).toBe('urgent')
    await expect.element(toast).toHaveTextContent('Please refresh')
    disconnect()
    await unmount()
  })
})
