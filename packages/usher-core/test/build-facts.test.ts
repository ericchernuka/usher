import { describe, expect, it } from 'vitest'
import { parseBuildFacts } from '../src/build-facts'

import { running } from './fixtures'

describe('parseBuildFacts', () => {
  it.each([
    ['an empty version', { ...running, version: '' }],
    ['a numeric version', { ...running, version: 123 }],
    ['a missing commit time', { ...running, commitTime: undefined }],
    ['an unreadable cutoff', { ...running, forceUpdateBuiltBefore: 'soon' }],
    ['null', null],
  ])('rejects %s', (_name, file) => {
    expect(parseBuildFacts(file).success).toBe(false)
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
