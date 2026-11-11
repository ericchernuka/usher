// Model-based tests: fast-check generates random worlds (escalation config, server clock
// skew) and event sequences (time, deploys, flapping builds, rollbacks, outages, visibility,
// typing, other tabs, dismissals, vetoes, reloads, resubscribes, clock jumps), and checks
// the state machine's invariants after every step.
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { installPlainClock } from './clock'
import type { AttentionChangeReason, UpdateState } from '../src/types'
import {
  aged,
  createWorld,
  current,
  IDLE_MS,
  random,
  rollbackThenFix,
  SNOOZE_KEY,
  urgentSnoozeMs,
} from './model/world'
import type { Action, Scenario, World } from './model/world'

const rank = { none: 0, passive: 1, prompt: 2, urgent: 3 }

const REASONS: Record<
  UpdateState['attention'],
  readonly AttentionChangeReason[]
> = {
  none: ['unknown', 'caught-up'],
  passive: ['new-build', 'dismiss', 'waiting', 'declined'],
  prompt: ['stale'],
  urgent: ['rollback', 'forced', 'expired'],
}

/** Header rounding (1 s) plus the offset jitter filter (2 s). */
const CLOCK_TOLERANCE_MS = 3_000

/** Configs where a prompt dismissal must hold until urgent: one prompt per level. */
const ONE_PROMPT = new Set(['default', 'fast'])

interface Change {
  w: World
  previous: UpdateState
  next: UpdateState
  raise: boolean
}

/** Invariants on each published change: [violated?, message]. */
const changeRules: Array<[(c: Change) => boolean, (c: Change) => string]> = [
  [
    ({ w, previous, next }) => {
      const offer = w.world.offers.at(-1)

      const changed =
        next.attention !== previous.attention || next.reason !== previous.reason

      return (
        changed &&
        !(
          offer?.attention === next.attention &&
          offer.reason === next.reason &&
          offer.accepted
        )
      )
    },
    ({ previous, next }) =>
      `${previous.reason}->${next.reason} published without an offer`,
  ],
  [({ w, raise }) => raise && !w.world.visible, () => 'raise while hidden'],
  [
    ({ w, raise }) => raise && performance.now() - w.world.lastInput < IDLE_MS,
    () => 'raise while busy',
  ],
  [
    ({ w, next }) =>
      next.reason === 'expired' &&
      w.serverNow() < w.world.urgentQuietUntil - CLOCK_TOLERANCE_MS,
    () => 'urgent snooze ended early',
  ],
  [
    ({ w, next }) => w.world.promptAcked && next.reason === 'stale',
    () => 'prompt shown twice for one level',
  ],
]

function changeViolations(
  w: World,
  previous: UpdateState,
  next: UpdateState,
): string[] {
  const raise =
    rank[next.attention] > rank[previous.attention] && rank[next.attention] >= 2

  const change = { w, previous, next, raise }

  return changeRules
    .filter(([violated]) => violated(change))
    .map(([, message]) => message(change))
}

/** Listener-side invariants, recorded (the store isolates listener errors) and asserted after each step. */
function watch(w: World) {
  let previous = w.store.getState()

  return w.store.subscribe(() => {
    const next = w.store.getState()
    w.world.violations.push(...changeViolations(w, previous, next))
    previous = next
  })
}

function dismissStep({ world, store, serverNow, host }: World) {
  const before = store.getState()
  const snooze = host.localStorage.getItem(SNOOZE_KEY)
  const ok = store.dismiss()
  // I-dismiss: false means nothing changed; true means attention dropped; a veto always wins.
  expect(
    ok
      ? rank[store.getState().attention] < rank[before.attention]
      : store.getState() === before,
  ).toBe(true)
  expect(
    ok || host.localStorage.getItem(SNOOZE_KEY) === snooze,
    'dismiss returned false but wrote a snooze',
  ).toBe(true)
  expect(
    !(ok && world.veto),
    "dismiss took effect despite the app's veto",
  ).toBe(true)

  if (ok && before.reason === 'stale' && ONE_PROMPT.has(world.config)) {
    world.promptAcked = true
  }
  if (ok && before.reason === 'expired') {
    world.urgentQuietUntil = serverNow() + urgentSnoozeMs(world.config)
  }
}

function otherTabSet(
  a: Extract<Action, { type: 'otherTabSet' }>,
  { serverNow, host }: World,
) {
  const stored = JSON.parse(
    host.host.localStorage.getItem(SNOOZE_KEY) ?? '{}',
  ) as Record<string, unknown>

  const at = serverNow()

  const next =
    a.kind === 'bad'
      ? {
          ...stored,
          bad: {
            [current.version]: { evidence: ['rollback'], until: at + a.ms },
          },
        }
      : { ...stored, [a.kind]: at }

  const value = JSON.stringify(next)
  host.otherTabSets(SNOOZE_KEY, value)
}

type Handler<T extends Action['type']> = (
  a: Extract<Action, { type: T }>,
  w: World,
  r: Run,
) => unknown

interface Run {
  stop: () => void
}

const handlers: { [T in Action['type']]: Handler<T> } = {
  advance: (a, { clock }) => clock.runFor(a.ms),
  serve: (a, { world }) => void (world.served = a.build),
  focus: (_a, { host }) => void host.focus(),
  visibility: (a, { world, host }) => {
    world.visible = a.visible
    host.setVisibility(a.visible ? 'visible' : 'hidden')
  },
  input: (_a, { world, host }) => {
    world.lastInput = performance.now()
    host.keydown()
  },
  dismiss: (_a, w) => dismissStep(w),
  otherTabClear: (_a, { world, host }) => {
    host.localStorage.removeItem(SNOOZE_KEY)
    world.promptAcked = false
    world.urgentQuietUntil = -Infinity
    host.storageEvent(null)
  },
  otherTabSet: (a, w) => otherTabSet(a, w),
  veto: (a, { world }) => void (world.veto = a.on),
  refresh: (_a, { store }) => store.refresh(),
  resubscribe: async (a, w, r) => {
    r.stop()
    await w.clock.runFor(a.gap)
    r.stop = watch(w)
  },
  clockJump: (a, { world }) => {
    world.jumped += a.ms
    vi.setSystemTime(Date.now() + a.ms) // the user's clock only; performance.now() keeps going
  },
}

/** State-side invariants after every step. */
function checkInvariants(
  { world, store, clock }: World,
  before: UpdateState,
  vetoedThroughout: boolean,
) {
  expect(world.violations).toEqual([])
  const s = store.getState()
  expect(REASONS[s.attention], `${s.attention}:${s.reason}`).toContain(s.reason) // reasons belong to their level
  expect(
    s.attention === 'none' || s.latest !== undefined,
    'behind without latest',
  ).toBe(true)
  // Hidden, the store sets no wake timer; only a check still in flight holds its own
  // timeout (and, with latency, the slow server's answer).
  const perCheck = world.latency > 0 ? 2 : 1
  expect(
    world.visible || clock.pendingStoreTimers() === world.inFlight * perCheck,
    'timer while hidden',
  ).toBe(true)
  const rose = rank[s.attention] > rank[before.attention]
  expect(!(vetoedThroughout && rose), 'raised despite veto').toBe(true)
  const idle = performance.now() - world.lastInput >= IDLE_MS
  expect(
    !(s.reason === 'waiting' && world.visible && idle),
    'stuck waiting while idle and visible',
  ).toBe(true)
  world.badSeen ||= s.reason === 'rollback' || s.reason === 'forced'

  // Once known bad, never shown as merely new/stale while behind.
  const okReasons = [
    'rollback',
    'forced',
    'dismiss',
    'waiting',
    'declined',
    'caught-up',
  ]

  expect(
    !world.badSeen || okReasons.includes(s.reason),
    `known-bad shown as ${s.reason}`,
  ).toBe(true)
}

async function run(scenario: Scenario) {
  const clock = installPlainClock()
  const w = createWorld(scenario, clock)
  const r: Run = { stop: watch(w) }

  try {
    for (const a of scenario.actions) {
      const before = w.store.getState()
      const vetoBefore = w.world.veto
      await (handlers[a.type] as Handler<Action['type']>)(a, w, r)
      await clock.settle()
      checkInvariants(w, before, vetoBefore && w.world.veto)
    }
  } finally {
    r.stop()
    clock.dispose()
  }
}

describe('state machine invariants under random worlds', () => {
  it('hold for 400 random sequences of up to 60 events', async () => {
    await fc.assert(fc.asyncProperty(random, run), { numRuns: 400 })
  }, 180_000)

  it('hold for 200 rollback-then-fix scenarios with random noise', async () => {
    await fc.assert(fc.asyncProperty(rollbackThenFix, run), { numRuns: 200 })
  }, 180_000)

  it('hold for 300 age-escalation scenarios (wait, dismiss, wait, dismiss)', async () => {
    await fc.assert(fc.asyncProperty(aged, run), { numRuns: 300 })
  }, 180_000)

  // Shrunk counterexamples worth keeping: random worlds rarely reach them again.
  it.each([
    {
      // A raise held for a busy user stayed "waiting" after they resubscribed idle, until
      // the slow check landed (or a poll later, had it failed). Fixed by evaluating on start.
      config: 'default',
      skew: 0,
      latency: 300,
      actions: [
        { type: 'input' },
        { type: 'serve', build: 'older' },
        { type: 'advance', ms: 1_000 }, // the rollback lands while the user is busy: held
        { type: 'resubscribe', gap: 6_000 }, // idle by the time they resubscribe
      ],
    },
  ] satisfies Scenario[])('hold for pinned scenario %#', run)
})
