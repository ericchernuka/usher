import { expectTypeOf, test } from 'vitest'
import type { BuildFacts, UpdateReason, UpdateState } from '../src/index'

test('given the UpdateState union, then it is exactly the documented states', () => {
  expectTypeOf<UpdateState>().toEqualTypeOf<
    | { attention: 'none'; reason: 'unknown'; latest?: undefined }
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

test('given any state, then latest and reason can be read without narrowing', () => {
  expectTypeOf<UpdateState['latest']>().toEqualTypeOf<BuildFacts | undefined>()
  expectTypeOf<UpdateReason>().toEqualTypeOf<
    'unknown' | 'caught-up' | 'outdated' | 'dismissed' | 'rollback' | 'forced'
  >()
})
