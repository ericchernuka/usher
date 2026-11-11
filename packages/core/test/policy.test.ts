import { describe, expect, it } from 'vitest'
import { resolveEscalation } from '../src/duration'
import { decide, isVersionInfo, type PolicyInput } from '../src/policy'
import type { VersionInfo } from '../src/types'

const at = (s: string) => new Date(s).getTime()
const H = 3_600_000

const v = (
  version: string,
  time: string,
  extra: Partial<VersionInfo> = {},
): VersionInfo => ({
  version,
  commitTime: new Date(time).toISOString(),
  builtAt: new Date(time).toISOString(),
  ...extra,
})

const current = v('aaa', '2026-11-11T09:00:00Z')
const newer = v('bbb', '2026-11-11T09:15:00Z')
const older = v('old', '2026-11-10T09:00:00Z')

const base = (o: Partial<PolicyInput> = {}): PolicyInput => ({
  current,
  latest: newer,
  now: at('2026-11-11T09:20:00Z'),
  clockOffset: 0,
  snoozes: {},
  escalation: resolveEscalation(),
  published: 'none',
  gateOpen: true,
  ...o,
})

const target = (o: Partial<PolicyInput> = {}) => decide(base(o)).target

describe('decide: levels by build age', () => {
  it('caught up when versions match', () => {
    expect(target({ latest: current })).toEqual({
      attention: 'none',
      reason: 'caught-up',
    })
  })
  it('passive for a newer build', () => {
    expect(target()).toEqual({ attention: 'passive', reason: 'new-build' })
  })
  it('prompt at 12 h, urgent at 24 h of build age (server clock)', () => {
    expect(target({ now: at('2026-11-11T20:59:00Z') }).attention).toBe(
      'passive',
    )
    expect(target({ now: at('2026-11-11T21:00:00Z') })).toEqual({
      attention: 'prompt',
      reason: 'stale',
    })
    expect(target({ now: at('2026-11-12T09:00:00Z') })).toEqual({
      attention: 'urgent',
      reason: 'expired',
    })
  })
  it('uses the server clock for age', () => {
    expect(
      target({ now: at('2026-11-11T09:20:00Z'), clockOffset: 24 * H }).reason,
    ).toBe('expired')
  })
  it('respects custom and disabled levels', () => {
    const escalation = resolveEscalation({
      prompt: false,
      urgent: { after: '2h' },
    })

    expect(
      target({ escalation, now: at('2026-11-11T10:59:00Z') }).attention,
    ).toBe('passive')
    expect(target({ escalation, now: at('2026-11-11T11:00:00Z') }).reason).toBe(
      'expired',
    )
  })
})

describe('decide: known-bad builds', () => {
  it('rollback and forced are urgent regardless of age', () => {
    expect(target({ latest: older })).toEqual({
      attention: 'urgent',
      reason: 'rollback',
    })

    const forced = v('ccc', '2026-11-11T10:00:00Z', {
      forceUpdateBefore: '2026-11-11T10:00:00Z',
    })

    expect(target({ latest: forced })).toEqual({
      attention: 'urgent',
      reason: 'forced',
    })
  })
  it("knownBad is sticky: a later fix doesn't lower it", () => {
    expect(
      target({
        latest: newer,
        knownBad: { reason: 'rollback', evidence: ['rollback'] },
      }),
    ).toEqual({
      attention: 'urgent',
      reason: 'rollback',
    })
  })
  it('reports bad for the caller to make sticky', () => {
    expect(decide(base({ latest: older })).bad).toEqual({
      reason: 'rollback',
      evidence: ['rollback'],
    })
  })
})

describe('decide: snoozes (server-clock dismissals)', () => {
  const now = at('2026-11-12T09:00:00Z') // 24 h: expired and stale
  const bad = { reason: 'rollback' as const, evidence: ['rollback'] }
  it('an urgent dismissal mutes urgent and prompt for its snooze', () => {
    expect(target({ now, snoozes: { urgentAt: now } })).toEqual({
      attention: 'passive',
      reason: 'dismiss',
    })
    expect(
      target({ now: now + 30 * 60_000, snoozes: { urgentAt: now } }).reason,
    ).toBe('expired')
  })
  it('a prompt dismissal mutes stale until urgent, not urgent', () => {
    const stale = at('2026-11-11T22:00:00Z')
    expect(target({ now: stale, snoozes: { promptAt: stale } })).toEqual({
      attention: 'passive',
      reason: 'dismiss',
    })
    expect(target({ now, snoozes: { promptAt: stale } }).reason).toBe('expired')
  })
  it('a dismissal only covers builds whose level had started (one prompt per level per build)', () => {
    const early = at('2026-11-11T20:00:00Z') // before our prompt started at 21:00
    expect(
      target({ now: at('2026-11-11T22:00:00Z'), snoozes: { promptAt: early } })
        .reason,
    ).toBe('stale')
  })
  it("clock offset jitter can't end a prompt dismissal early", () => {
    const stale = at('2026-11-11T22:00:00Z')
    const almostUrgent = at('2026-11-12T08:59:59Z')
    expect(
      target({
        now: almostUrgent,
        clockOffset: -1000,
        snoozes: { promptAt: stale },
      }).reason,
    ).toBe('dismiss')
  })
  it('an age dismissal never hides a known-bad build', () => {
    expect(target({ latest: older, snoozes: { urgentAt: now } }).reason).toBe(
      'rollback',
    )
  })
  it('a bad dismissal is keyed by our build and evidence, not by latest', () => {
    const snoozes = {
      bad: {
        aaa: { evidence: ['rollback'], until: at('2026-11-11T10:00:00Z') },
      },
    }

    expect(target({ latest: older, snoozes })).toEqual({
      attention: 'passive',
      reason: 'dismiss',
    })
    expect(target({ latest: newer, knownBad: bad, snoozes }).reason).toBe(
      'dismiss',
    ) // a fix shipping

    const forced = v('ccc', '2026-11-11T09:30:00Z', {
      forceUpdateBefore: '2026-11-11T09:30:00Z',
    })

    expect(target({ latest: forced, knownBad: bad, snoozes }).reason).toBe(
      'forced',
    ) // new evidence
  })
  it('passive says dismiss only while a snooze holds something back', () => {
    expect(
      target({ snoozes: { urgentAt: at('2026-11-11T09:10:00Z') } }).reason,
    ).toBe('new-build')
  })
})

describe('decide: forced rebuild of the same version', () => {
  it('a cutoff after our build forces even when the version matches', () => {
    const rebuilt = { ...current, forceUpdateBefore: '2026-11-11T10:00:00Z' }
    expect(target({ latest: rebuilt })).toEqual({
      attention: 'urgent',
      reason: 'forced',
    })
  })
})

describe('decide: the raise gate', () => {
  it('holds a raise from none/passive as passive:waiting', () => {
    const d = decide(base({ latest: older, gateOpen: false }))
    expect(d.target.attention).toBe('urgent')
    expect(d.publish).toEqual({ attention: 'passive', reason: 'waiting' })
  })
  it('holds at prompt:stale when prompt is already published', () => {
    const d = decide(
      base({ latest: older, gateOpen: false, published: 'prompt' }),
    )

    expect(d.publish).toEqual({ attention: 'prompt', reason: 'stale' })
  })
  it('never holds a lowering', () => {
    const d = decide(
      base({ latest: current, gateOpen: false, published: 'urgent' }),
    )

    expect(d.publish.attention).toBe('none')
  })
})

describe('decide: deadlines', () => {
  it('includes threshold crossings and snooze expiry in the future only', () => {
    const now = at('2026-11-11T09:20:00Z')
    const d = decide(base({ now, snoozes: { urgentAt: now } }))
    expect(d.deadlines).toEqual(
      expect.arrayContaining([
        at('2026-11-11T21:00:00Z'),
        at('2026-11-12T09:00:00Z'),
        now + 30 * 60_000,
      ]),
    )
    expect(d.deadlines.every(t => t > now)).toBe(true)
  })
})

describe('resolveEscalation', () => {
  it('validates durations and ordering', () => {
    expect(() =>
      resolveEscalation({ prompt: { after: '12 hours' as never } }),
    ).toThrow(/not a duration/)
    expect(() =>
      resolveEscalation({ prompt: { after: '24h' }, urgent: { after: '12h' } }),
    ).toThrow(/later than/)
    expect(() =>
      resolveEscalation({ urgent: { after: '24h', snooze: '0m' } }),
    ).toThrow(/positive/)
    expect(resolveEscalation({ prompt: false, urgent: false })).toEqual({})
  })
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
