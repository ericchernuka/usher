import { describe, expect, it } from 'vitest'
import {
  resolveAttention,
  isVersionInfo,
  type AttentionInput,
} from '../src/attention'
import { resolveEscalation } from '../src/duration'
import { current, newer, older, HOUR } from './fixtures'

const at = (hours: number) => Date.parse(current.builtAt) + hours * HOUR

const input = (patch: Partial<AttentionInput> = {}): AttentionInput => ({
  current,
  latest: newer,
  now: at(1),
  dismissal: {},
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
    expect(resolveAttention(input({ now: at(hours) })).state).toEqual({
      attention,
      reason,
      latest: newer,
    })
  },
)

it('uses the supplied server time and returns the next server deadline', () => {
  const result = resolveAttention(input({ now: at(12) }))
  expect(result.state.attention).toBe('prompt')
  expect(result.nextAt).toBe(at(24))
  expect(resolveAttention(input({ latest: current }))).toEqual({
    state: { attention: 'none', reason: 'caught-up', latest: current },
  })
})

it('keeps rollback and forced urgency even if the latest later matches the running version', () => {
  expect(resolveAttention(input({ latest: older })).knownBad).toBe('rollback')
  expect(
    resolveAttention(input({ latest: current, knownBad: 'rollback' })).state
      .reason,
  ).toBe('rollback')
  const forced = { ...current, forceUpdateBefore: '2026-11-12T00:00:00Z' }
  expect(resolveAttention(input({ latest: forced })).state.reason).toBe(
    'forced',
  )
  expect(
    resolveAttention(input({ latest: forced, knownBad: 'rollback' })).knownBad,
  ).toBe('forced')
})

it('does not apply an old forced cutoff', () => {
  expect(
    resolveAttention(
      input({ latest: { ...current, forceUpdateBefore: current.builtAt } }),
    ).state.attention,
  ).toBe('none')
})

it('shares prompt dismissal until urgent, without muting urgent', () => {
  const dismissal = { promptAt: at(13) }
  expect(resolveAttention(input({ now: at(14), dismissal })).state.reason).toBe(
    'dismiss',
  )
  expect(resolveAttention(input({ now: at(24), dismissal })).state.reason).toBe(
    'expired',
  )
  expect(
    resolveAttention(input({ now: at(14), dismissal: { promptAt: at(11) } }))
      .state.reason,
  ).toBe('stale')
  expect(
    resolveAttention(input({ now: at(14), dismissal, latest: older })).state
      .reason,
  ).toBe('rollback')
})

it('supports an explicit prompt snooze and disabled age levels', () => {
  const escalation = resolveEscalation({
    prompt: { after: '2h', snooze: '1h' },
    urgent: false,
  })

  expect(
    resolveAttention(
      input({ now: at(2), escalation, dismissal: { promptAt: at(2) } }),
    ).nextAt,
  ).toBe(at(3))
  expect(
    resolveAttention(
      input({ now: at(3), escalation, dismissal: { promptAt: at(2) } }),
    ).state.reason,
  ).toBe('stale')
  expect(
    resolveAttention(
      input({
        now: at(40),
        escalation: resolveEscalation({ prompt: false, urgent: false }),
      }),
    ).state.reason,
  ).toBe('new-build')
  expect(
    resolveAttention(
      input({ now: at(1), escalation: resolveEscalation({ prompt: false }) }),
    ).nextAt,
  ).toBe(at(24))
})

it('with urgent disabled, a default prompt dismissal has no expiry', () => {
  expect(
    resolveAttention(
      input({
        now: at(40),
        escalation: resolveEscalation({ urgent: false }),
        dismissal: { promptAt: at(13) },
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
