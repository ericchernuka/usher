import * as fc from 'fast-check'
import type { BuildFacts } from '../src/types'
import { describe, expect, it, vi } from 'vitest'
import { DISMISSAL_KEY, HOUR, running } from './fixtures'
import { aged, createWorld, random, rollbackThenFix } from './model/world'
import type { Action, Scenario, World } from './model/world'

interface Run {
  stop: () => void
  stickyUrgency: boolean
  promptQuietUntil: number
}

function dismiss(harness: World, run: Run) {
  const before = harness.store.getState()
  const stored = harness.tab.storage.getItem(DISMISSAL_KEY)
  const dismissed = harness.store.dismiss()

  if (before.attention !== 'prompt') {
    expect(dismissed).toBe(false)
  }

  if (dismissed) {
    expect(before.attention).toBe('prompt')
    expect(harness.store.getState().attention).toBe('passive')
    run.promptQuietUntil =
      harness.world.config === 'promptSnooze'
        ? harness.serverNow() + HOUR
        : Infinity
  } else {
    expect(harness.store.getState()).toBe(before)
    expect(harness.tab.storage.getItem(DISMISSAL_KEY)).toBe(stored)
  }
}

async function tabAction(
  step: Exclude<
    Action,
    { type: 'advance' | 'serve' | 'focus' | 'visibility' | 'dismissed' }
  >,
  harness: World,
  run: Run,
) {
  switch (step.type) {
    case 'otherTabClear':
      harness.tab.otherTabClears()
      run.promptQuietUntil = -Infinity

      return
    case 'otherTabSet':
      harness.tab.otherTabSets(
        DISMISSAL_KEY,
        JSON.stringify({ dismissedAt: harness.serverNow() }),
      )

      return
    case 'refresh':
      await harness.store.refresh()

      return
    case 'resubscribe':
      await harness.tab.advance(step.gap)
      run.stop = harness.store.subscribe(() => {})

      return
    case 'clockJump':
      harness.world.jumped += step.ms
      harness.tab.setSystemTime(harness.tab.now() + step.ms)

      return
  }
}

function action(step: Action, harness: World, run: Run) {
  switch (step.type) {
    case 'advance':
      return harness.tab.advance(step.ms)
    case 'serve':
      harness.world.served = step.build

      return
    case 'focus':
      harness.tab.focus()

      return
    case 'visibility':
      harness.world.visible = step.visible
      harness.tab.setVisibility(step.visible ? 'visible' : 'hidden')

      return
    case 'dismissed':
      return dismiss(harness, run)
    default:
      return tabAction(step, harness, run)
  }
}

function stickyUrgencyInvariant(
  harness: World,
  run: Run,
  accepted: BuildFacts[],
) {
  const state = harness.store.getState()
  run.stickyUrgency ||= accepted.some(
    build =>
      Date.parse(build.commitTime) < Date.parse(running.commitTime) ||
      Date.parse(build.forceUpdateBuiltBefore ?? '') >
        Date.parse(running.buildTime),
  )

  if (run.stickyUrgency) {
    expect(state.attention).toBe('urgent')
    expect(['rollback', 'forced']).toContain(state.reason)
  }
}

function invariants(harness: World, run: Run) {
  const state = harness.store.getState()

  const accepted = harness.delivered
    .splice(0)
    .flatMap(({ build, signal }) => (signal?.aborted ? [] : [build]))

  stickyUrgencyInvariant(harness, run, accepted)

  if (accepted.some(build => build.version === running.version)) {
    run.promptQuietUntil = -Infinity
  }

  if (state.attention !== 'none') {
    expect(state.latest).toBeDefined()
  }

  if (harness.serverNow() < run.promptQuietUntil - 3_000) {
    expect(state.attention).not.toBe('prompt')
  }

  if (!harness.world.visible) {
    const timersPerCheck = harness.world.latency > 0 ? 2 : 1
    expect(harness.tab.pendingTimers()).toBe(
      harness.world.inFlight * timersPerCheck,
    )
  }
}

async function runScenario(scenario: Scenario) {
  const harness = createWorld(scenario)

  const run: Run = {
    stop: harness.store.subscribe(() => {}),
    stickyUrgency: false,
    promptQuietUntil: -Infinity,
  }

  try {
    for (const step of scenario.actions) {
      if (step.type === 'resubscribe') {
        run.stop()
      }

      await action(step, harness, run)
      await harness.tab.flush()
      invariants(harness, run)
    }
  } finally {
    run.stop()
    vi.restoreAllMocks()
  }
}

describe('state invariants under random worlds', () => {
  it('hold for 400 random sequences of up to 60 events', async () => {
    await fc.assert(fc.asyncProperty(random, runScenario), { numRuns: 400 })
  }, 180_000)
  it('hold for 200 rollback-then-fix scenarios with random noise', async () => {
    await fc.assert(fc.asyncProperty(rollbackThenFix, runScenario), {
      numRuns: 200,
    })
  }, 180_000)
  it('hold for 300 age escalation scenarios with prompt dismissal', async () => {
    await fc.assert(fc.asyncProperty(aged, runScenario), { numRuns: 300 })
  }, 180_000)
})
