import { describe, expect, it } from 'vitest'
import { parseBuildFacts } from '../src/types'

import { running } from './fixtures'

describe('parseBuildFacts', () => {
  it('accepts a well-formed file and rejects junk', () => {
    expect(parseBuildFacts(running).success).toBe(true)
    expect(parseBuildFacts({}).success).toBe(false)
    expect(
      parseBuildFacts({ ...running, buildTime: 'yesterday-ish' }).success,
    ).toBe(false)
    expect(parseBuildFacts('<!doctype html>').success).toBe(false)
  })
})

describe('parseBuildFacts edge cases', () => {
  it('accepts a file with a force-update cutoff and fields it does not know about', () => {
    const file = {
      ...running,
      forceUpdateBuiltBefore: running.buildTime,
      extra: 1,
    }

    expect(parseBuildFacts(file).success).toBe(true)
  })

  it.each([
    ['an empty version', { ...running, version: '' }],
    ['a numeric version', { ...running, version: 123 }],
    ['a missing commit time', { ...running, commitTime: undefined }],
    ['an unreadable cutoff', { ...running, forceUpdateBuiltBefore: 'soon' }],
    ['null', null],
  ])('rejects %s', (_name, file) => {
    expect(parseBuildFacts(file).success).toBe(false)
  })
})

describe('parseBuildFacts output', () => {
  it('drops fields it does not know about', () => {
    expect(parseBuildFacts({ ...running, extra: 1 })).toMatchObject({
      success: true,
      output: running,
    })
    expect(parseBuildFacts({ ...running, extra: 1 }).output).not.toHaveProperty(
      'extra',
    )
  })

  it.each([
    ['a date without a time', '2026-11-11'],
    ['a time without a zone', '2026-11-11T15:30:00'],
    ['prose', 'Wed, 11 Nov 2026 15:30:00 GMT'],
  ])('rejects %s as a timestamp', (_name, buildTime) => {
    expect(parseBuildFacts({ ...running, buildTime }).success).toBe(false)
  })

  it('accepts a timestamp with an offset', () => {
    const facts = { ...running, commitTime: '2026-11-11T08:00:00-07:00' }

    expect(parseBuildFacts(facts).success).toBe(true)
  })
})
