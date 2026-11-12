import { expectTypeOf, test } from 'vitest'
import type { BuildFacts, UpdateState } from '../src/index'

test('given the UpdateState union, then it is exactly the documented states', () => {
  expectTypeOf<UpdateState>().toEqualTypeOf<
    | { attention: 'none'; reason: 'unknown' }
    | { attention: 'none'; reason: 'caught-up'; latest: BuildFacts }
    | {
        attention: 'passive'
        reason: 'outdated' | 'dismissed'
        latest: BuildFacts
      }
    | { attention: 'prompt'; reason: 'outdated'; latest: BuildFacts }
    | {
        attention: 'urgent'
        reason: 'outdated' | 'rollback' | 'forced'
        latest: BuildFacts
      }
  >()
})

test('given the UpdateState union, then impossible states do not compile', () => {
  expectTypeOf<{
    attention: 'none'
    reason: 'dismissed'
  }>().not.toExtend<UpdateState>()
  expectTypeOf<{
    attention: 'urgent'
    reason: 'rollback'
  }>().not.toExtend<UpdateState>()
  expectTypeOf<{
    attention: 'prompt'
    reason: 'rollback'
    latest: BuildFacts
  }>().not.toExtend<UpdateState>()

  const unknownWithLatest: UpdateState = {
    attention: 'none',
    reason: 'unknown',
    // @ts-expect-error An unknown state has no latest build.
    latest: { version: 'a', commitTime: '', buildTime: '' },
  }

  expectTypeOf(unknownWithLatest).toExtend<UpdateState>()
})
