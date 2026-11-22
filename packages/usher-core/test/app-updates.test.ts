import { expect, test, vi } from 'vitest'
import { createAppUpdates, createUpdateNotice, type Tab } from '../src/index'
import { createTestTab } from '../src/testing'
import { HOUR, newer, older, running } from './fixtures'

const versionUrl = '/version.json'

test('given a test tab, when a build is deployed and time passes, then the app escalates as it would in a browser', async () => {
  const tab = createTestTab()
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const stop = updates.state.subscribe(() => {})

  await tab.advance(0)
  expect(updates.state.get().reason).toBe('unknown')

  tab.deploy({ ...newer, buildTime: new Date(tab.now()).toISOString() })
  await tab.advance(5 * 60_000)
  expect(updates.state.get()).toMatchObject({
    attention: 'passive',
    reason: 'outdated',
  })

  await tab.advance(12 * HOUR)
  expect(updates.state.get().attention).toBe('prompt')
  stop()
})

test('given a build deployed before the app subscribes, when less time passes than a check may take, then the first check still lands', async () => {
  const tab = createTestTab()
  tab.deploy(newer)
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const stop = updates.state.subscribe(() => {})

  await tab.advance(30_000)

  expect(updates.state.get().latest).toEqual(newer)
  stop()
})

test('given only the refresh is subscribed, then no version check is made', async () => {
  const tab = createTestTab()
  tab.deploy(newer)
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const stop = updates.refresh.subscribe(() => {})
  await tab.advance(HOUR)

  expect(updates.state.get().reason).toBe('unknown')
  stop()
})

test('given a notice read declaratively, then it says how to present itself and closing follows the surface rules', async () => {
  const tab = createTestTab()
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const notice = createUpdateNotice(updates, { minAttention: 'passive' })
  const heard = vi.fn<() => void>()
  expect(notice.get()).toBeUndefined()
  tab.deploy({ ...newer, buildTime: new Date(tab.now()).toISOString() })
  const stop = notice.subscribe(heard)
  await tab.advance(0)
  const passive = notice.get()
  expect(passive).toMatchObject({
    attention: 'passive',
    closable: true,
    announce: 'off',
  })

  passive?.close()
  expect(notice.get()).toBeUndefined()
  expect(heard).toHaveBeenCalled()

  tab.deploy(older)
  await tab.advance(5 * 60_000)
  const urgent = notice.get()
  expect(urgent).toMatchObject({
    reason: 'rollback',
    closable: false,
    announce: 'assertive',
  })

  passive?.close()
  expect(notice.get()).toBe(urgent)

  stop()
  expect(notice.get()).toBeUndefined()
})

test('given a tab from another copy of the library, then creating the app fails saying how to fix it', () => {
  const foreign: Tab = JSON.parse('{}')

  expect(() => createAppUpdates({ running, versionUrl }, foreign)).toThrow(
    /not made by this copy of @rndsqr\/usher-core.*only one version/,
  )
})
