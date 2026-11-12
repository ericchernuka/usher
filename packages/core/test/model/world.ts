import * as fc from 'fast-check'
import { vi } from 'vitest'
import type { Escalation, BuildFacts } from '../../src/types'
import type { Clock } from '../clock'
import { createFakeHost, createStore } from '../fake-host'

const H = 3_600_000
export const DISMISSAL_KEY = 'app-version:prompt-dismissal'

export const running: BuildFacts = {
  version: 'aaa',
  commitTime: '2026-11-11T15:00:00.000Z',
  buildTime: '2026-11-11T15:00:00.000Z',
}

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
    forceUpdateBefore: '2026-11-11T17:00:00.000Z',
  },
} satisfies Record<string, BuildFacts>

export type Build = keyof typeof builds

export type Served = Build | 'offline' | 'malformed' | { flap: [Build, Build] }

const configs = {
  default: {},
  noPrompt: { prompt: false },
  noUrgent: { urgent: false },
  promptSnooze: { prompt: { after: '12h', snooze: '1h' } },
  off: { prompt: false, urgent: false },
  fast: { prompt: { after: '2h' }, urgent: { after: '3h' } },
} satisfies Record<string, Escalation>

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
      .map(([a, b]): Served => ({ flap: [a, b] })),
  },
)

const duration = fc.oneof(
  fc.integer({ min: 0, max: 10_000 }),
  fc.integer({ min: 60_000, max: 2 * H }),
  fc.integer({ min: 6 * H, max: 14 * H }),
)

const t = <T extends Action['type']>(type: T) => fc.constant(type)

const visibilityAction = fc.record({
  type: t('visibility'),
  visible: fc.boolean(),
})

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: t('advance'), ms: duration }) },
  { weight: 3, arbitrary: fc.record({ type: t('serve'), build: served }) },
  { weight: 2, arbitrary: fc.record({ type: t('focus') }) },
  { weight: 1, arbitrary: visibilityAction },
  { weight: 3, arbitrary: fc.record({ type: t('dismissed') }) },
  { weight: 1, arbitrary: fc.record({ type: t('otherTabClear') }) },
  { weight: 1, arbitrary: fc.record({ type: t('otherTabSet') }) },
  { weight: 1, arbitrary: fc.record({ type: t('refresh') }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: t('resubscribe'),
      gap: fc.integer({ min: 0, max: 2 * H }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: t('clockJump'),
      ms: fc.integer({ min: -24 * H, max: 24 * H }),
    }),
  },
)

export interface Scenario {
  config: ConfigName
  skew: number
  latency: number
  actions: Action[]
}

const scenario = (actions: fc.Arbitrary<Action[]>): fc.Arbitrary<Scenario> =>
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
    skew: fc.oneof(fc.constant(0), fc.integer({ min: -3 * H, max: 3 * H })),
    latency: fc.constantFrom(0, 0, 300, 5_000, 35_000),
    actions,
  })

const noise = fc.array(action, { maxLength: 10 })

export const random = scenario(fc.array(action, { maxLength: 60 }))

export const rollbackThenFix = scenario(
  fc
    .tuple(noise, noise, fc.constantFrom<Build>('newer', 'newest', 'running'))
    .map(([a, b, fix]): Action[] =>
      Array.of<Action>(
        { type: 'serve', build: 'older' },
        { type: 'focus' },
        { type: 'advance', ms: 61_000 },
      ).concat(
        a,
        [
          { type: 'serve', build: fix },
          { type: 'advance', ms: 61_000 },
          { type: 'focus' },
        ],
        b,
      ),
    ),
)

export const aged = scenario(
  fc
    .tuple(
      fc.integer({ min: 0, max: 30 * H }),
      noise,
      fc.integer({ min: 6 * H, max: 14 * H }),
      noise,
    )
    .map(([first, a, second, b]): Action[] =>
      Array.of<Action>(
        { type: 'serve', build: 'newer' },
        { type: 'focus' },
        { type: 'advance', ms: first },
        { type: 'dismissed' },
      ).concat(a, [{ type: 'advance', ms: second }, { type: 'dismissed' }], b),
    ),
)

function initialServed(): Served {
  return 'running'
}

interface DeliveredBuild {
  build: BuildFacts
  signal: AbortSignal | null | undefined
}

export function createWorld(s: Scenario, clock: Clock) {
  const delivered: DeliveredBuild[] = []

  const world = {
    config: s.config,
    visible: true,
    jumped: 0,
    latency: s.latency,
    inFlight: 0,
    served: initialServed(),
    flips: 0,
  }

  const serverNow = () => Date.now() - world.jumped + s.skew

  const respond = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    world.inFlight++

    try {
      if (s.latency > 0) {
        await answerAfter(s.latency, init?.signal)
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

  const host = createFakeHost({ fetch: respond })
  vi.spyOn(console, 'warn').mockImplementation(() => {})

  const store = createStore(host, {
    escalation: configs[s.config],
    reload: async () => false,
  })

  return { world, store, serverNow, host, clock, delivered }
}

export type World = ReturnType<typeof createWorld>

function answerAfter(ms: number, signal: AbortSignal | null | undefined) {
  return new Promise<void>((resolve, reject) => {
    const answer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(answer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
