import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as client from '../src/client'
import { createAppUpdates, runningBuild as embeddedBuild } from '../src/client'
import { createTestTab } from '@ericchernuka/usher-core/testing'
import { runningBuild } from './build-info.stub'

const SECOND = 1_000

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

it('exports the store factory and the running build', () => {
  expect(Object.keys(client).toSorted()).toEqual([
    'createAppUpdates',
    'runningBuild',
  ])
  expect(embeddedBuild).toEqual(runningBuild)
})

it('uses the embedded build and version URL without configuration', async () => {
  const updates = createAppUpdates()
  const stop = updates.state.subscribe(() => {})

  try {
    await vi.waitFor(() =>
      expect(updates.state.get()).toEqual({
        attention: 'none',
        reason: 'caught-up',
        latest: runningBuild,
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^http.+\/version\.json\?t=\d+$/),
      expect.objectContaining({ cache: 'no-store' }),
    )
  } finally {
    stop()
  }
})

it('forwards the configured polling interval to the core store', async () => {
  const updates = createAppUpdates({ pollInterval: 10 * SECOND })
  const stop = updates.state.subscribe(() => {})

  try {
    await vi.waitFor(() => expect(updates.state.get().reason).toBe('caught-up'))
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * SECOND)
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    stop()
  }
})

it('runs on a test tab, where a deploy and twelve hours bring the prompt', async () => {
  vi.useRealTimers()
  const tab = createTestTab()
  const updates = createAppUpdates({}, tab)
  const stop = updates.state.subscribe(() => {})

  tab.deploy({
    ...runningBuild,
    version: 'next',
    buildTime: new Date(tab.now()).toISOString(),
  })
  await tab.advance(5 * 60 * SECOND)
  expect(updates.state.get().attention).toBe('passive')

  await tab.advance(12 * 60 * 60 * SECOND)
  expect(updates.state.get().attention).toBe('prompt')
  stop()
})
