import * as fc from 'fast-check'
import type { Environment } from '../../src/environment'
import { vi } from 'vitest'
import { createFakeEnvironment } from '../fake-environment'
import type { BuildFacts } from '../../src/types'
import { createStore, running, type StoreOptions } from '../fixtures'

const HOUR = 3_600 * 1_000

const builds = {
  running,
  newer: {
    ...running,
    version: 'bbb',
    commitTime: '2026-11-11T15:30:00.000Z',
    buildTime: '2026-11-11T15:30:00.000Z',
  },
  newest: {
    ...running,
    version: 'ccc',
    commitTime: '2026-11-11T16:30:00.000Z',
    buildTime: '2026-11-11T16:30:00.000Z',
  },
  older: { ...running, version: 'old', commitTime: '2026-11-10T15:00:00.000Z' },
  forced: {
    ...running,
    version: 'fix',
    commitTime: '2026-11-11T17:00:00.000Z',
    buildTime: '2026-11-11T17:00:00.000Z',
    forceUpdateBuiltBefore: '2026-11-11T17:00:00.000Z',
  },
} satisfies Record<string, BuildFacts>

export type Build = keyof typeof builds

export type Served = Build | 'offline' | 'malformed' | { flap: [Build, Build] }

const configs = {
  default: {},
  noPrompt: { promptAfter: false },
  noUrgent: { urgentAfter: false },
  promptSnooze: { promptSnooze: HOUR },
  off: { promptAfter: false, urgentAfter: false },
  fast: { promptAfter: 2 * HOUR, urgentAfter: 3 * HOUR },
} satisfies Record<string, StoreOptions>

export type ConfigName = keyof typeof configs

export type Action =
  | { type: 'advance'; ms: number }
  | { type: 'serve'; build: Served }
  | { type: 'focus' }
  | { type: 'visibility'; visible: boolean }
  | { type: 'dismissed' }
  | { type: 'otherTabClear' }
  | { type: 'otherTabSet' }
  | { type: 'refresh' }
  | { type: 'resubscribe'; gap: number }
  | { type: 'clockJump'; ms: number }

const build = fc.constantFrom<Build>(
  'running',
  'newer',
  'newest',
  'older',
  'forced',
)

const served: fc.Arbitrary<Served> = fc.oneof(
  {
    weight: 10,
    arbitrary: fc.constantFrom<Served>(
      'running',
      'newer',
      'newest',
      'offline',
      'malformed',
    ),
  },
  { weight: 1, arbitrary: fc.constantFrom<Served>('older', 'forced') },
  {
    weight: 2,
    arbitrary: fc
      .tuple(build, build)
      .map(([first, second]): Served => ({ flap: [first, second] })),
  },
)

const duration = fc.oneof(
  fc.integer({ min: 0, max: 10_000 }),
  fc.integer({ min: 60_000, max: 2 * HOUR }),
  fc.integer({ min: 6 * HOUR, max: 14 * HOUR }),
)

const actionType = <Type extends Action['type']>(type: Type) =>
  fc.constant(type)

const visibilityAction = fc.record({
  type: actionType('visibility'),
  visible: fc.boolean(),
})

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ type: actionType('advance'), ms: duration }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ type: actionType('serve'), build: served }),
  },
  { weight: 2, arbitrary: fc.record({ type: actionType('focus') }) },
  { weight: 1, arbitrary: visibilityAction },
  { weight: 3, arbitrary: fc.record({ type: actionType('dismissed') }) },
  { weight: 1, arbitrary: fc.record({ type: actionType('otherTabClear') }) },
  { weight: 1, arbitrary: fc.record({ type: actionType('otherTabSet') }) },
  { weight: 1, arbitrary: fc.record({ type: actionType('refresh') }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: actionType('resubscribe'),
      gap: fc.integer({ min: 0, max: 2 * HOUR }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: actionType('clockJump'),
      ms: fc.integer({ min: -24 * HOUR, max: 24 * HOUR }),
    }),
  },
)

export interface Scenario {
  config: ConfigName
  skew: number
  latency: number
  actions: Action[]
}

const scenarioOf = (actions: fc.Arbitrary<Action[]>): fc.Arbitrary<Scenario> =>
  fc.record({
    config: fc.constantFrom(
      ...([
        'default',
        'noPrompt',
        'noUrgent',
        'promptSnooze',
        'off',
        'fast',
      ] satisfies ConfigName[]),
    ),
    skew: fc.oneof(
      fc.constant(0),
      fc.integer({ min: -3 * HOUR, max: 3 * HOUR }),
    ),
    latency: fc.constantFrom(0, 0, 300, 5_000, 35_000),
    actions,
  })

const noise = fc.array(action, { maxLength: 10 })

export const random = scenarioOf(fc.array(action, { maxLength: 60 }))

export const rollbackThenFix = scenarioOf(
  fc
    .tuple(noise, noise, fc.constantFrom<Build>('newer', 'newest', 'running'))
    .map(([beforeFix, afterFix, fix]): Action[] =>
      Array.of<Action>(
        { type: 'serve', build: 'older' },
        { type: 'focus' },
        { type: 'advance', ms: 61_000 },
      ).concat(
        beforeFix,
        [
          { type: 'serve', build: fix },
          { type: 'advance', ms: 61_000 },
          { type: 'focus' },
        ],
        afterFix,
      ),
    ),
)

export const aged = scenarioOf(
  fc
    .tuple(
      fc.integer({ min: 0, max: 30 * HOUR }),
      noise,
      fc.integer({ min: 6 * HOUR, max: 14 * HOUR }),
      noise,
    )
    .map(([firstWait, noiseBetween, secondWait, noiseAfter]): Action[] =>
      Array.of<Action>(
        { type: 'serve', build: 'newer' },
        { type: 'focus' },
        { type: 'advance', ms: firstWait },
        { type: 'dismissed' },
      ).concat(
        noiseBetween,
        [{ type: 'advance', ms: secondWait }, { type: 'dismissed' }],
        noiseAfter,
      ),
    ),
)

function initialServed(): Served {
  return 'running'
}

interface DeliveredBuild {
  build: BuildFacts
  signal: AbortSignal | null | undefined
}

export function createWorld(scenario: Scenario) {
  const delivered: DeliveredBuild[] = []

  const world = {
    config: scenario.config,
    visible: true,
    jumped: 0,
    latency: scenario.latency,
    inFlight: 0,
    served: initialServed(),
    flips: 0,
  }

  const serverNow = () => tab.now() - world.jumped + scenario.skew

  const respond = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    world.inFlight++

    try {
      if (scenario.latency > 0) {
        await answerAfter(scenario.latency, init?.signal, tab.env)
      }

      return serve(init?.signal)
    } finally {
      world.inFlight--
    }
  }

  const serve = (signal: AbortSignal | null | undefined): Response => {
    const choice = world.served

    if (choice === 'offline') {
      throw new TypeError('offline')
    }

    if (choice === 'malformed') {
      return Response.json({})
    }

    const name =
      choice instanceof Object ? choice.flap[world.flips++ % 2]! : choice

    const headers = { date: new Date(serverNow()).toUTCString() }
    const response = Response.json(builds[name], { headers })
    delivered.push({ build: builds[name], signal })

    return response
  }

  const tab = createFakeEnvironment({ fetch: respond })
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  const store = createStore(tab, {
    ...configs[scenario.config],
    reload: async () => false,
  })

  return { world, store, serverNow, tab, delivered }
}

export type World = ReturnType<typeof createWorld>

function answerAfter(
  ms: number,
  signal: AbortSignal | null | undefined,
  env: Pick<Environment, 'startTimer'>,
) {
  return new Promise<void>((resolve, reject) => {
    const cancel = env.startTimer(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        cancel()
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
