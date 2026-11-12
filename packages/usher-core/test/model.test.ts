import * as fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { DISMISSAL_KEY, HOUR, running } from './fixtures'
import { aged, createWorld, random, rollbackThenFix } from './model/world'
import type { Action, Scenario, World } from './model/world'

interface Run {
  stop: () => void
  stickyUrgency: boolean
  promptQuietUntil: number
}

function dismiss(w: World, r: Run) {
  const before = w.store.getState()
  const stored = w.tab.storage.getItem(DISMISSAL_KEY)
  const dismissed = w.store.dismiss()

  if (before.attention !== 'prompt') {
    expect(dismissed).toBe(false)
  }

  if (dismissed) {
    expect(before.attention).toBe('prompt')
    expect(w.store.getState().attention).toBe('passive')
    r.promptQuietUntil =
      w.world.config === 'promptSnooze' ? w.serverNow() + HOUR : Infinity
  } else {
    expect(w.store.getState()).toBe(before)
    expect(w.tab.storage.getItem(DISMISSAL_KEY)).toBe(stored)
  }
}

async function tabAction(
  a: Exclude<
    Action,
    { type: 'advance' | 'serve' | 'focus' | 'visibility' | 'dismissed' }
  >,
  w: World,
  r: Run,
) {
  switch (a.type) {
    case 'otherTabClear':
      w.tab.otherTabClears()
      r.promptQuietUntil = -Infinity

      return
    case 'otherTabSet':
      w.tab.otherTabSets(
        DISMISSAL_KEY,
        JSON.stringify({ dismissedAt: w.serverNow() }),
      )

      return
    case 'refresh':
      await w.store.refresh()

      return
    case 'resubscribe':
      await w.tab.advance(a.gap)
      r.stop = w.store.subscribe(() => {})

      return
    case 'clockJump':
      w.world.jumped += a.ms
      w.tab.setSystemTime(w.tab.now() + a.ms)

      return
  }
}

function action(a: Action, w: World, r: Run) {
  switch (a.type) {
    case 'advance':
      return w.tab.advance(a.ms)
    case 'serve':
      w.world.served = a.build

      return
    case 'focus':
      w.tab.focus()

      return
    case 'visibility':
      w.world.visible = a.visible
      w.tab.setVisibility(a.visible ? 'visible' : 'hidden')

      return
    case 'dismissed':
      return dismiss(w, r)
    default:
      return tabAction(a, w, r)
  }
}

function stickyUrgencyInvariant(w: World, r: Run) {
  const state = w.store.getState()
  const delivered = w.delivered.splice(0)
  r.stickyUrgency ||= delivered.some(
    ({ build, signal }) =>
      !signal?.aborted &&
      (Date.parse(build.commitTime) < Date.parse(running.commitTime) ||
        Date.parse(build.forceUpdateBefore ?? '') >
          Date.parse(running.buildTime)),
  )

  if (r.stickyUrgency) {
    expect(state.attention).toBe('urgent')
    expect(['rollback', 'forced']).toContain(state.reason)
  }
}

function invariants(w: World, r: Run) {
  const state = w.store.getState()
  stickyUrgencyInvariant(w, r)

  if (state.attention !== 'none') {
    expect(state.latest).toBeDefined()
  }

  if (w.serverNow() < r.promptQuietUntil - 3_000) {
    expect(state.attention).not.toBe('prompt')
  }

  if (!w.world.visible) {
    const timersPerCheck = w.world.latency > 0 ? 2 : 1
    expect(w.tab.pendingTimers()).toBe(w.world.inFlight * timersPerCheck)
  }
}

async function run(scenario: Scenario) {
  const w = createWorld(scenario)

  const r: Run = {
    stop: w.store.subscribe(() => {}),
    stickyUrgency: false,
    promptQuietUntil: -Infinity,
  }

  try {
    for (const a of scenario.actions) {
      if (a.type === 'resubscribe') {
        r.stop()
      }

      await action(a, w, r)
      await w.tab.flush()
      invariants(w, r)
    }
  } finally {
    r.stop()
    vi.restoreAllMocks()
  }
}

describe('state invariants under random worlds', () => {
  it('hold for 400 random sequences of up to 60 events', async () => {
    await fc.assert(fc.asyncProperty(random, run), { numRuns: 400 })
  }, 180_000)
  it('hold for 200 rollback-then-fix scenarios with random noise', async () => {
    await fc.assert(fc.asyncProperty(rollbackThenFix, run), { numRuns: 200 })
  }, 180_000)
  it('hold for 300 age escalation scenarios with prompt dismissal', async () => {
    await fc.assert(fc.asyncProperty(aged, run), { numRuns: 300 })
  }, 180_000)
})
