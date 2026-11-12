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
