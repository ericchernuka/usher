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

test('given a passive notice was closed and its reader left, when the tab catches up and falls behind again, then a returning reader sees the notice', async () => {
  const tab = createTestTab()
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const notice = createUpdateNotice(updates, { minAttention: 'passive' })
  const stopState = updates.state.subscribe(() => {})

  const deploy = () =>
    tab.deploy({ ...newer, buildTime: new Date(tab.now()).toISOString() })

  deploy()
  const leave = notice.subscribe(() => {})
  await tab.advance(5 * 60_000)
  notice.get()?.close()
  expect(notice.get()).toBeUndefined()
  leave()

  tab.deploy(running)
  await tab.advance(5 * 60_000)
  deploy()
  await tab.advance(5 * 60_000)
  const stop = notice.subscribe(() => {})

  expect(notice.get()).toMatchObject({ attention: 'passive' })
  stop()
  stopState()
})

test('given a passive notice was closed, when its reader leaves and returns with nothing changed, then it stays closed', async () => {
  const tab = createTestTab()
  tab.deploy({ ...newer, buildTime: new Date(tab.now()).toISOString() })
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const notice = createUpdateNotice(updates, { minAttention: 'passive' })
  const leave = notice.subscribe(() => {})
  await tab.advance(0)
  notice.get()?.close()
  leave()

  const stop = notice.subscribe(() => {})

  expect(notice.get()).toBeUndefined()
  stop()
})

test('given a passive notice was closed and its only reader left, when a newer build is deployed after it returns, then it stays closed', async () => {
  const tab = createTestTab()
  const buildTime = new Date(tab.now()).toISOString()
  tab.deploy({ ...newer, buildTime })
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const notice = createUpdateNotice(updates, { minAttention: 'passive' })
  const leave = notice.subscribe(() => {})
  await tab.advance(0)
  notice.get()?.close()
  leave()

  tab.deploy({ ...newer, version: 'ccc', buildTime })
  const stop = notice.subscribe(() => {})
  await tab.advance(5 * 60_000)

  expect(updates.state.get().latest?.version).toBe('ccc')
  expect(notice.get()).toBeUndefined()
  stop()
})

test('given a returning reader closes the prompt it is given as it subscribes, then the prompt is dismissed and no notice comes back', async () => {
  const tab = createTestTab()
  tab.deploy({ ...newer, buildTime: new Date(tab.now()).toISOString() })
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const notice = createUpdateNotice(updates, { minAttention: 'passive' })
  const leave = notice.subscribe(() => {})
  await tab.advance(0)
  leave()
  await tab.advance(13 * HOUR)

  const stop = notice.subscribe(() => notice.get()?.close())

  expect(updates.state.get().reason).toBe('dismissed')
  expect(notice.get()).toBeUndefined()
  stop()
})

test('given a reader that closes every notice it is given, when attention is urgent, then the notice stays and the reader is not called again', async () => {
  const tab = createTestTab()
  tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const notice = createUpdateNotice(updates)
  let calls = 0

  const stop = notice.subscribe(() => {
    calls++
    notice.get()?.close()
  })

  await tab.advance(0)
  const urgent = notice.get()

  expect(urgent).toMatchObject({ attention: 'urgent', closable: false })
  expect(calls).toBeLessThan(5)
  urgent?.close()
  expect(notice.get()).toBe(urgent)
  stop()
})

test('given overlapping advances, then time moves by their sum, and an advance that is not a duration is refused', async () => {
  const tab = createTestTab()
  const start = tab.now()

  await Promise.all([tab.advance(30_000), tab.advance(60_000)])

  expect(tab.now() - start).toBe(90_000)
  expect(() => tab.advance(Number.NaN)).toThrow(
    /advance needs a finite, non-negative number of milliseconds, got NaN/,
  )
})

test('given a tab from another copy of the library, then creating the app fails saying how to fix it', () => {
  const foreign: Tab = JSON.parse('{}')

  expect(() => createAppUpdates({ running, versionUrl }, foreign)).toThrow(
    /not made by this copy of @rndsqr\/usher-core.*only one version/,
  )
})
