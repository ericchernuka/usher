import { describe, expect, it } from 'vitest'
import { isBuildFacts } from '../src/types'
import { running } from './fixtures'

describe('isBuildFacts', () => {
  it('accepts a well-formed file and rejects junk', () => {
    expect(isBuildFacts(running)).toBe(true)
    expect(isBuildFacts({})).toBe(false)
    expect(isBuildFacts({ ...running, buildTime: 'yesterday-ish' })).toBe(false)
    expect(isBuildFacts('<!doctype html>')).toBe(false)
  })
})

describe('isBuildFacts edge cases', () => {
  it('accepts a file with a force-update cutoff and fields it does not know about', () => {
    const file = {
      ...running,
      forceUpdateBuiltBefore: running.buildTime,
      extra: 1,
    }

    expect(isBuildFacts(file)).toBe(true)
  })

  it.each([
    ['an empty version', { ...running, version: '' }],
    ['a numeric version', { ...running, version: 123 }],
    ['a missing commit time', { ...running, commitTime: undefined }],
    ['an unreadable cutoff', { ...running, forceUpdateBuiltBefore: 'soon' }],
    ['null', null],
  ])('rejects %s', (_name, file) => {
    expect(isBuildFacts(file)).toBe(false)
  })
})
