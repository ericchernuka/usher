import { describe, expect, it } from 'vitest'
import { decide, isVersionInfo, type PolicyInput } from '../src/policy'
import { resolveEscalation } from '../src/duration'
import { current, newer, older, HOUR } from './fixtures'

const at = (hours: number) => Date.parse(current.builtAt) + hours * HOUR

const input = (patch: Partial<PolicyInput> = {}): PolicyInput => ({
  current,
  latest: newer,
  now: at(1),
  clockOffset: 0,
  snoozes: {},
  escalation: resolveEscalation(),
  ...patch,
})

it.each([
  { hours: 1, attention: 'passive', reason: 'new-build' },
  { hours: 12, attention: 'prompt', reason: 'stale' },
  { hours: 24, attention: 'urgent', reason: 'expired' },
])(
  'at $hours hours reports $attention:$reason',
  ({ hours, attention, reason }) => {
    expect(decide(input({ now: at(hours) })).state).toEqual({
      attention,
      reason,
      latest: newer,
    })
  },
)

it('uses server time and returns the next client deadline', () => {
  const result = decide(input({ clockOffset: 11 * HOUR }))
  expect(result.state.attention).toBe('prompt')
  expect(result.nextAt).toBe(at(13))
  expect(decide(input({ latest: current }))).toEqual({
    state: { attention: 'none', reason: 'caught-up', latest: current },
  })
})

it('keeps rollback and forced urgency even if the latest later matches the running version', () => {
  expect(decide(input({ latest: older })).knownBad).toBe('rollback')
  expect(
    decide(input({ latest: current, knownBad: 'rollback' })).state.reason,
  ).toBe('rollback')
  const forced = { ...current, forceUpdateBefore: '2026-11-12T00:00:00Z' }
  expect(decide(input({ latest: forced })).state.reason).toBe('forced')
  expect(decide(input({ latest: forced, knownBad: 'rollback' })).knownBad).toBe(
    'forced',
  )
})

it('does not apply an old forced cutoff', () => {
  expect(
    decide(
      input({ latest: { ...current, forceUpdateBefore: current.builtAt } }),
    ).state.attention,
  ).toBe('none')
})

it('shares prompt dismissal until urgent, without muting urgent', () => {
  const snoozes = { promptAt: at(13) }
  expect(decide(input({ now: at(14), snoozes })).state.reason).toBe('dismiss')
  expect(decide(input({ now: at(24), snoozes })).state.reason).toBe('expired')
  expect(
    decide(input({ now: at(14), snoozes: { promptAt: at(11) } })).state.reason,
  ).toBe('stale')
  expect(
    decide(input({ now: at(14), snoozes, latest: older })).state.reason,
  ).toBe('rollback')
})

it('supports an explicit prompt snooze and disabled age levels', () => {
  const escalation = resolveEscalation({
    prompt: { after: '2h', snooze: '1h' },
    urgent: false,
  })

  expect(
    decide(input({ now: at(2), escalation, snoozes: { promptAt: at(2) } }))
      .nextAt,
  ).toBe(at(3))
  expect(
    decide(input({ now: at(3), escalation, snoozes: { promptAt: at(2) } }))
      .state.reason,
  ).toBe('stale')
  expect(
    decide(
      input({
        now: at(40),
        escalation: resolveEscalation({ prompt: false, urgent: false }),
      }),
    ).state.reason,
  ).toBe('new-build')
  expect(
    decide(
      input({ now: at(1), escalation: resolveEscalation({ prompt: false }) }),
    ).nextAt,
  ).toBe(at(24))
})

it('with urgent disabled, a default prompt dismissal has no expiry', () => {
  expect(
    decide(
      input({
        now: at(40),
        escalation: resolveEscalation({ urgent: false }),
        snoozes: { promptAt: at(13) },
      }),
    ),
  ).toEqual({
    state: { attention: 'passive', reason: 'dismiss', latest: newer },
  })
})

it('validates durations, snooze lengths and threshold order', () => {
  expect(() =>
    resolveEscalation(JSON.parse('{"prompt":{"after":"12 hours"}}')),
  ).toThrow(/not a duration/)
  expect(() =>
    resolveEscalation({ prompt: { after: '24h' }, urgent: { after: '12h' } }),
  ).toThrow(/later than/)
  expect(() =>
    resolveEscalation({ prompt: { after: '12h', snooze: '0m' } }),
  ).toThrow(/positive/)
})

describe('isVersionInfo', () => {
  it('accepts a well-formed file and rejects junk', () => {
    expect(isVersionInfo(current)).toBe(true)
    expect(isVersionInfo({})).toBe(false)
    expect(isVersionInfo({ ...current, builtAt: 'yesterday-ish' })).toBe(false)
    expect(isVersionInfo('<!doctype html>')).toBe(false)
  })
})

describe('isVersionInfo edge cases', () => {
  it('accepts a file with a force-update cutoff and fields it does not know about', () => {
    const file = { ...current, forceUpdateBefore: current.builtAt, extra: 1 }

    expect(isVersionInfo(file)).toBe(true)
  })

  it.each([
    ['an empty version', { ...current, version: '' }],
    ['a numeric version', { ...current, version: 123 }],
    ['a missing commit time', { ...current, commitTime: undefined }],
    ['an unreadable cutoff', { ...current, forceUpdateBefore: 'soon' }],
    ['null', null],
  ])('rejects %s', (_name, file) => {
    expect(isVersionInfo(file)).toBe(false)
  })
})
