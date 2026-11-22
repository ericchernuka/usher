import { expect, expectTypeOf, test, vi } from 'vitest'
import {
  createAppUpdates,
  createRefresh,
  createUpdateNotice,
  createUpdateState,
  createVersionCheck,
  defineSignal,
  escalation,
  rollback,
} from '../src/index'
import { createTestTab } from '../src/testing'
import { HOUR, newer, older, running } from './fixtures'

const versionUrl = '/version.json'

const unsupported = () =>
  defineSignal({
    initial: false,
    observe: (seen: boolean, builds) =>
      seen || builds.latest.version === 'unsupported',
    ask: seen =>
      seen
        ? { claim: { attention: 'urgent', reason: 'unsupported' } }
        : undefined,
  })

function compose(tab = createTestTab()) {
  const latest = createVersionCheck(tab, { versionUrl })

  const state = createUpdateState(tab, {
    running,
    latest,
    signals: [unsupported(), rollback(), escalation()],
  })

  return { tab, state, refresh: createRefresh(tab) }
}

test('given a test tab, when a build is deployed and time passes, then the preset escalates as it would in a browser', async () => {
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

test('given a custom signal, then its reason is published and typed, and the earlier signal wins a tie', async () => {
  const { tab, state } = compose()
  tab.deploy({ ...older, version: 'unsupported' })
  const stop = state.subscribe(() => {})
  await tab.advance(0)

  expect(state.get()).toMatchObject({
    attention: 'urgent',
    reason: 'unsupported',
  })
  expectTypeOf(state.get().reason).toEqualTypeOf<
    | 'unknown'
    | 'caught-up'
    | 'dismissed'
    | 'unsupported'
    | 'rollback'
    | 'outdated'
  >()
  stop()
})

test('given a composition without a dismissal, then a prompt cannot be dismissed', async () => {
  const { tab, state } = compose()
  tab.deploy({ ...newer, buildTime: new Date(tab.now()).toISOString() })
  const stop = state.subscribe(() => {})
  await tab.advance(13 * HOUR)

  expect(state.get().attention).toBe('prompt')
  expect(state.dismiss()).toBe(false)
  expect(state.get().attention).toBe('prompt')
  stop()
})

test('given only the refresh behaviour is subscribed, then no version check is made', async () => {
  const tab = createTestTab()
  tab.deploy(newer)
  const updates = createAppUpdates({ running, versionUrl }, tab)
  const stop = updates.refresh.subscribe(() => {})
  await tab.advance(HOUR)

  expect(updates.state.get().reason).toBe('unknown')
  stop()
})

test('given a notice read declaratively, then it says how to present itself and closing follows the surface rules', async () => {
  const composed = compose()
  const notice = createUpdateNotice(composed, { minAttention: 'passive' })
  const heard = vi.fn<() => void>()
  expect(notice.get()).toBeUndefined()
  composed.tab.deploy({
    ...newer,
    buildTime: new Date(composed.tab.now()).toISOString(),
  })
  const stop = notice.subscribe(heard)
  await composed.tab.advance(0)
  const passive = notice.get()
  expect(passive).toMatchObject({
    attention: 'passive',
    closable: true,
    announce: 'off',
  })

  passive?.close()
  expect(notice.get()).toBeUndefined()
  expect(heard).toHaveBeenCalled()

  composed.tab.deploy(older)
  await composed.tab.advance(5 * 60_000)
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

test('given a tab that was not made by createTab, then creating a behaviour fails saying so', () => {
  expect(() => createRefresh({ now: Date.now })).toThrow(
    /tab must come from createTab\(\)/,
  )
})
