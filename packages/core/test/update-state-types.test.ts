import type { UpdateState } from '../src/index'
import { current, expect, test } from './fixtures'

test('given the UpdateState union, then impossible states do not compile', () => {
  // @ts-expect-error none can't carry "dismiss"
  const none: UpdateState = { attention: 'none', reason: 'dismiss' }
  // @ts-expect-error a level that is behind always has `latest`
  const missingLatest: UpdateState = { attention: 'urgent', reason: 'rollback' }

  // @ts-expect-error reasons belong to their level
  const wrongReason: UpdateState = {
    attention: 'prompt',
    reason: 'rollback',
    latest: current,
  }

  // The assertions are the compiler's (`pnpm check:types`); this keeps the values used.
  expect([none, missingLatest, wrongReason]).toHaveLength(3)
})
