import { expect, test } from 'vitest'
import * as core from '../src/index'
import * as testing from '../src/testing'

test('given the package entry, then it exports exactly the documented functions', () => {
  expect(Object.keys(core).toSorted()).toEqual([
    'connectUpdateSurface',
    'createAppUpdates',
    'createPromptDismissal',
    'createRefresh',
    'createTab',
    'createUpdateNotice',
    'createUpdateState',
    'createVersionCheck',
    'defineSignal',
    'escalation',
    'forcedUpdate',
    'rollback',
  ])
})

test('given the testing entry, then it exports exactly the test tab', () => {
  expect(Object.keys(testing)).toEqual(['createTestTab'])
})
