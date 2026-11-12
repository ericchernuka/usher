import * as fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { installPlainClock } from './clock'
import {
  aged,
  createWorld,
  current,
  random,
  rollbackThenFix,
  SNOOZE_KEY,
} from './model/world'
import type { Action, Scenario, World } from './model/world'

interface Run {
  stop: () => void
  knownBad: boolean
  promptQuietUntil: number
}

function dismiss(w: World, r: Run) {
  const before = w.store.getState()
  const stored = w.host.localStorage.getItem(SNOOZE_KEY)
  const dismissed = w.store.dismiss()

  if (before.attention !== 'prompt') {
    expect(dismissed).toBe(false)
  }

  if (dismissed) {
    expect(before.attention).toBe('prompt')
    expect(w.store.getState().attention).toBe('passive')
    r.promptQuietUntil =
      w.world.config === 'promptSnooze' ? w.serverNow() + 3_600_000 : Infinity
  } else {
    expect(w.store.getState()).toBe(before)
    expect(w.host.localStorage.getItem(SNOOZE_KEY)).toBe(stored)
  }
}

async function tabAction(
  a: Exclude<
    Action,
    { type: 'advance' | 'serve' | 'focus' | 'visibility' | 'dismiss' }
  >,
  w: World,
  r: Run,
) {
  switch (a.type) {
    case 'otherTabClear':
      w.host.localStorage.removeItem(SNOOZE_KEY)
      w.host.storageEvent(null)
      r.promptQuietUntil = -Infinity

      return
    case 'otherTabSet':
      w.host.otherTabSets(
        SNOOZE_KEY,
        JSON.stringify({ promptAt: w.serverNow() }),
      )

      return
    case 'refresh':
      await w.store.refresh()

      return
    case 'resubscribe':
      await w.clock.runFor(a.gap)
      r.stop = w.store.subscribe(() => {})

      return
    case 'clockJump':
      w.world.jumped += a.ms
      vi.setSystemTime(Date.now() + a.ms)

      return
  }
}

function action(a: Action, w: World, r: Run) {
  switch (a.type) {
    case 'advance':
      return w.clock.runFor(a.ms)
    case 'serve':
      w.world.served = a.build

      return
    case 'focus':
      w.host.focus()

      return
    case 'visibility':
      w.world.visible = a.visible
      w.host.setVisibility(a.visible ? 'visible' : 'hidden')

      return
    case 'dismiss':
      return dismiss(w, r)
    default:
      return tabAction(a, w, r)
  }
}

function knownBadInvariant(w: World, r: Run) {
  const state = w.store.getState()
  const latest = state.latest

  if (!latest) {
    return
  }

  r.knownBad ||=
    Date.parse(latest.commitTime) < Date.parse(current.commitTime) ||
    Date.parse(latest.forceUpdateBefore ?? '') > Date.parse(current.builtAt)

  if (r.knownBad) {
    expect(state.attention).toBe('urgent')
    expect(['rollback', 'forced']).toContain(state.reason)
  }
}

function invariants(w: World, r: Run) {
  const state = w.store.getState()
  knownBadInvariant(w, r)

  if (state.attention !== 'none') {
    expect(state.latest).toBeDefined()
  }

  if (w.serverNow() < r.promptQuietUntil - 3_000) {
    expect(state.attention).not.toBe('prompt')
  }

  if (!w.world.visible) {
    const timersPerCheck = w.world.latency > 0 ? 2 : 1
    expect(w.clock.pendingStoreTimers()).toBe(w.world.inFlight * timersPerCheck)
  }
}

async function run(scenario: Scenario) {
  const clock = installPlainClock()
  const w = createWorld(scenario, clock)

  const r: Run = {
    stop: w.store.subscribe(() => {}),
    knownBad: false,
    promptQuietUntil: -Infinity,
  }

  try {
    for (const a of scenario.actions) {
      if (a.type === 'resubscribe') {
        r.stop()
      }

      await action(a, w, r)
      await clock.settle()
      invariants(w, r)
    }
  } finally {
    r.stop()
    clock.dispose()
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
