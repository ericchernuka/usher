import { expect, test } from 'vitest'
import * as core from '../src/index'

test('given the package entry, then it exports exactly the two documented functions', () => {
  expect(Object.keys(core).toSorted()).toEqual([
    'connectUpdateSurface',
    'createAppUpdates',
  ])
})
