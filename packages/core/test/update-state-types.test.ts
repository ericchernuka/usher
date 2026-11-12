import { expectTypeOf, test } from 'vitest'
import type { UpdateState, VersionInfo } from '../src/index'

test('given the UpdateState union, then impossible states do not compile', () => {
  expectTypeOf<{
    attention: 'none'
    reason: 'dismiss'
  }>().not.toExtend<UpdateState>()
  expectTypeOf<{
    attention: 'urgent'
    reason: 'rollback'
  }>().not.toExtend<UpdateState>()
  expectTypeOf<{
    attention: 'prompt'
    reason: 'rollback'
    latest: VersionInfo
  }>().not.toExtend<UpdateState>()
})
