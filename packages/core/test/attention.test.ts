import { expect, it } from 'vitest'
import { resolveAttention, type AttentionInput } from '../src/attention'
import { resolveThresholds } from '../src/options'
import { running, newer, older, HOUR } from './fixtures'

const at = (hours: number) => Date.parse(running.buildTime) + hours * HOUR

const input = (patch: Partial<AttentionInput> = {}): AttentionInput => ({
  running,
  latest: newer,
  now: at(1),
  dismissal: {},
  thresholds: resolveThresholds(),
  ...patch,
})

it.each([
  { hours: 1, attention: 'passive', reason: 'outdated' },
  { hours: 12, attention: 'prompt', reason: 'outdated' },
  { hours: 24, attention: 'urgent', reason: 'outdated' },
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
  expect(resolveAttention(input({ latest: running }))).toEqual({
    state: { attention: 'none', reason: 'caught-up', latest: running },
  })
})

it('keeps rollback and forced urgency even if the latest later matches the running version', () => {
  expect(resolveAttention(input({ latest: older })).stickyUrgency).toBe(
    'rollback',
  )
  expect(
    resolveAttention(input({ latest: running, stickyUrgency: 'rollback' }))
      .state.reason,
  ).toBe('rollback')
  const forced = { ...running, forceUpdateBefore: '2026-11-12T00:00:00Z' }
  expect(resolveAttention(input({ latest: forced })).state.reason).toBe(
    'forced',
  )
  expect(
    resolveAttention(input({ latest: forced, stickyUrgency: 'rollback' }))
      .stickyUrgency,
  ).toBe('forced')
})

it('does not apply an old forced cutoff', () => {
  expect(
    resolveAttention(
      input({ latest: { ...running, forceUpdateBefore: running.buildTime } }),
    ).state.attention,
  ).toBe('none')
})

it('shares prompt dismissal until urgent, without muting urgent', () => {
  const dismissal = { dismissedAt: at(13) }
  expect(resolveAttention(input({ now: at(14), dismissal })).state.reason).toBe(
    'dismissed',
  )
  expect(
    resolveAttention(input({ now: at(24), dismissal })).state.attention,
  ).toBe('urgent')
  expect(
    resolveAttention(input({ now: at(14), dismissal: { dismissedAt: at(11) } }))
      .state.attention,
  ).toBe('prompt')
  expect(
    resolveAttention(input({ now: at(14), dismissal, latest: older })).state
      .reason,
  ).toBe('rollback')
})

it('supports an explicit prompt snooze and disabled age levels', () => {
  const thresholds = resolveThresholds({
    promptAfter: 2 * HOUR,
    promptSnooze: HOUR,
    urgentAfter: false,
  })

  expect(
    resolveAttention(
      input({ now: at(2), thresholds, dismissal: { dismissedAt: at(2) } }),
    ).nextAt,
  ).toBe(at(3))
  expect(
    resolveAttention(
      input({ now: at(3), thresholds, dismissal: { dismissedAt: at(2) } }),
    ).state.attention,
  ).toBe('prompt')
  expect(
    resolveAttention(
      input({
        now: at(40),
        thresholds: resolveThresholds({
          promptAfter: false,
          urgentAfter: false,
        }),
      }),
    ).state.attention,
  ).toBe('passive')
  expect(
    resolveAttention(
      input({
        now: at(1),
        thresholds: resolveThresholds({ promptAfter: false }),
      }),
    ).nextAt,
  ).toBe(at(24))
})

it('with urgent disabled, a default prompt dismissal has no expiry', () => {
  expect(
    resolveAttention(
      input({
        now: at(40),
        thresholds: resolveThresholds({ urgentAfter: false }),
        dismissal: { dismissedAt: at(13) },
      }),
    ),
  ).toEqual({
    state: { attention: 'passive', reason: 'dismissed', latest: newer },
  })
})
