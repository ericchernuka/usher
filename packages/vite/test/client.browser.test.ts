import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAppUpdates } from '../src/client'
import { runningBuild } from './build-info.stub'

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'],
  })
  vi.setSystemTime(new Date('2026-11-11T16:00:00Z'))
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Response.json(runningBuild)),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('uses the embedded build and version URL without configuration', async () => {
  const updates = createAppUpdates()
  const stop = updates.subscribe(() => {})

  try {
    await vi.waitFor(() =>
      expect(updates.getState()).toEqual({
        attention: 'none',
        reason: 'caught-up',
        latest: runningBuild,
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/version\.json\?t=\d+$/),
      expect.objectContaining({ cache: 'no-store' }),
    )
  } finally {
    stop()
  }
})

it('forwards the configured polling interval to the core store', async () => {
  const updates = createAppUpdates({ pollEvery: '10s' })
  const stop = updates.subscribe(() => {})

  try {
    await vi.waitFor(() => expect(updates.getState().reason).toBe('caught-up'))
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    stop()
  }
})
