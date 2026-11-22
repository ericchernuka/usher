import { virtual } from '@guidepup/virtual-screen-reader'
import { createAppUpdates } from '@rndsqr/usher-core'
import { createTestTab } from '@rndsqr/usher-core/testing'
import { createRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { UpdateNotice } from '../src/index'
import { runningBuild, versionUrl } from './build-info.stub'

const HOUR = 60 * 60 * 1000

beforeEach(async () => {
  localStorage.clear()
  await virtual.start({ container: document.body })
})

afterEach(async () => {
  await virtual.stop()
})

const newer = {
  version: 'new',
  commitTime: '2026-11-12T00:00:00Z',
}

const older = {
  version: 'old',
  commitTime: '2026-11-10T15:00:00.000Z',
}

async function notice(served: typeof newer, minAttention?: 'passive') {
  const tab = createTestTab()
  tab.deploy({ ...served, buildTime: new Date(tab.now()).toISOString() })
  const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

  const view = await render(
    <UpdateNotice.Root updates={updates} minAttention={minAttention}>
      {shown => (
        <>
          <p>Update available: {shown.attention}</p>
          <UpdateNotice.Refresh>Refresh</UpdateNotice.Refresh>
          <UpdateNotice.Close>Close</UpdateNotice.Close>
        </>
      )}
    </UpdateNotice.Root>,
  )

  return { tab, view }
}

const settled = () => new Promise(resolve => setTimeout(resolve, 250))

async function announcements() {
  await settled()

  return (await virtual.spokenPhraseLog()).filter(phrase =>
    /^(polite|assertive): \S/.test(phrase),
  )
}

function Wording() {
  const [blocked, setBlocked] = useState(false)

  return (
    <>
      <p>{blocked ? 'Save your work first' : 'Please refresh'}</p>
      <span aria-hidden="true">decoration</span>
      <button type="button" onClick={() => setBlocked(true)}>
        Block
      </button>
    </>
  )
}

describe('what a screen reader hears', () => {
  it('given a passive notice, then nothing is announced', async () => {
    const { tab, view } = await notice(newer, 'passive')
    await tab.advance(HOUR)

    await expect
      .element(view.getByText('Update available: passive'))
      .toBeVisible()
    expect(await announcements()).toEqual([])
    await view.unmount()
  })

  it('given a tab reaches prompt attention, then the notice is announced politely, once, without its controls', async () => {
    const { tab, view } = await notice(newer)
    await tab.advance(13 * HOUR)

    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    expect(await announcements()).toEqual(['polite: Update available: prompt'])
    await view.unmount()
  })

  it('given a prompt escalates to urgent, then the notice is announced again, assertively', async () => {
    const { tab, view } = await notice(newer)
    await tab.advance(13 * HOUR)
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    await tab.advance(12 * HOUR)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(await announcements()).toEqual([
      'polite: Update available: prompt',
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a tab is urgent from its first check, then the notice is announced assertively', async () => {
    const { tab, view } = await notice(older)
    await tab.advance(0)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(await announcements()).toEqual([
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a tab passes through prompt to urgent before anything is said, then only the urgent notice is announced', async () => {
    const { tab, view } = await notice(newer)
    await tab.advance(25 * HOUR)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(await announcements()).toEqual([
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a prompt is closed, then the announcement is cleared and nothing more is said', async () => {
    const { tab, view } = await notice(newer)
    await tab.advance(13 * HOUR)
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    await view.getByRole('button', { name: 'Close' }).click()

    await expect.element(view.getByRole('status')).toHaveTextContent('')
    expect(await announcements()).toEqual(['polite: Update available: prompt'])
    await view.unmount()
  })

  it('given two notices on one page, then the update is announced once', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const view = await render(
      <>
        <UpdateNotice.Root updates={updates} minAttention="passive">
          {shown => <p>Update available: {shown.attention}</p>}
        </UpdateNotice.Root>
        <UpdateNotice.Root updates={updates}>
          {shown => <p>Update available: {shown.attention}</p>}
        </UpdateNotice.Root>
      </>,
    )

    await tab.advance(0)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(await announcements()).toEqual([
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given the reason changes at the same attention, then the new wording is announced', async () => {
    const tab = createTestTab()
    const buildTime = new Date(tab.now()).toISOString()
    tab.deploy({ ...older, buildTime })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const view = await render(
      <UpdateNotice.Root updates={updates}>
        {shown => <p>Refresh because of a {shown.reason}</p>}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Refresh because of a rollback')

    tab.deploy({ ...newer, buildTime, forceUpdateBuiltBefore: buildTime })
    await tab.advance(5 * 60_000)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Refresh because of a forced')
    expect(await announcements()).toEqual([
      'assertive: Refresh because of a rollback',
      'assertive: Refresh because of a forced',
    ])
    await view.unmount()
  })

  it('given the wording inside a notice changes, then the new wording is announced, without text hidden from assistive technology', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const view = await render(
      <UpdateNotice.Root updates={updates}>
        {() => <Wording />}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Please refresh')
    await view.getByRole('button', { name: 'Block' }).click()

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Save your work first')
    expect(await announcements()).toEqual([
      'assertive: Please refresh',
      'assertive: Save your work first',
    ])
    await view.unmount()
  })

  it('given the app passes its own ref to the root, then it gets the element and the notice is still announced', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)
    const measured = createRef<HTMLDivElement>()

    const view = await render(
      <UpdateNotice.Root ref={measured} updates={updates}>
        {shown => <p>Update available: {shown.attention}</p>}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(measured.current?.dataset['attention']).toBe('urgent')
    await view.unmount()
  })

  it('given a root hidden from the page, then nothing is announced for it', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const view = await render(
      <UpdateNotice.Root hidden updates={updates}>
        {shown => <p>Update available: {shown.attention}</p>}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)
    await expect.poll(() => updates.state.get().attention).toBe('urgent')

    expect(await announcements()).toEqual([])
    await view.unmount()
  })

  it('given another app prompts while an urgent notice is about to be announced, then both are announced', async () => {
    const first = createTestTab()
    first.deploy({ ...older, buildTime: new Date(first.now()).toISOString() })
    const second = createTestTab()
    second.deploy({ ...newer, buildTime: new Date(second.now()).toISOString() })

    const urgent = createAppUpdates(
      { running: runningBuild, versionUrl },
      first,
    )

    const prompting = createAppUpdates(
      { running: runningBuild, versionUrl, storageKey: 'billing' },
      second,
    )

    const view = await render(
      <>
        <UpdateNotice.Root updates={urgent}>
          {() => <p>Refresh now</p>}
        </UpdateNotice.Root>
        <UpdateNotice.Root updates={prompting}>
          {() => <p>An update is ready</p>}
        </UpdateNotice.Root>
      </>,
    )

    await Promise.all([first.advance(0), second.advance(13 * HOUR)])

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Refresh now')
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('An update is ready')
    await view.unmount()
  })

  it('given a second notice for the same update mounts later and then leaves, then nothing is repeated and the first stays announced', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const one = (
      <UpdateNotice.Root updates={updates}>
        {shown => <p>Update available: {shown.attention}</p>}
      </UpdateNotice.Root>
    )

    const view = await render(one)
    await tab.advance(0)
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')

    await view.rerender(
      <>
        {one}
        <UpdateNotice.Root updates={updates}>
          {shown => <p>Update available: {shown.attention}</p>}
        </UpdateNotice.Root>
      </>,
    )
    await settled()
    await view.rerender(one)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(await announcements()).toEqual([
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a notice inside a hidden section, when the section is revealed, then the notice is announced, without text hidden by a style', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const section = (hidden: boolean) => (
      <section hidden={hidden}>
        <UpdateNotice.Root updates={updates}>
          {() => (
            <>
              <p>Please refresh</p>
              <p style={{ display: 'none' }}>for small screens</p>
            </>
          )}
        </UpdateNotice.Root>
      </section>
    )

    const view = await render(section(true))
    await tab.advance(0)
    await expect.poll(() => updates.state.get().attention).toBe('urgent')
    expect(await announcements()).toEqual([])

    await view.rerender(section(false))

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Please refresh')
    expect(await announcements()).toEqual(['assertive: Please refresh'])
    await view.unmount()
  })

  it('given a notice leaves before its wording is announced, then only the notice that stays is announced', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const staying = (
      <UpdateNotice.Root updates={updates}>
        {() => <p>Still shown</p>}
      </UpdateNotice.Root>
    )

    const view = await render(
      <>
        {staying}
        <UpdateNotice.Root updates={updates}>
          {() => <p>Gone</p>}
        </UpdateNotice.Root>
      </>,
    )

    await tab.advance(0)
    await expect.element(view.getByText('Gone')).toBeVisible()
    await view.rerender(staying)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Still shown')
    await settled()
    expect(view.getByRole('alert').element().textContent).toBe('Still shown')
    expect(await announcements()).toEqual(['assertive: Still shown'])
    await view.unmount()
  })

  it('given wording hidden by visibility and wording inside a box with no box of its own, then only what is seen is announced', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const view = await render(
      <UpdateNotice.Root updates={updates}>
        {() => (
          <>
            <p style={{ display: 'contents' }}>Please refresh</p>
            <p style={{ visibility: 'hidden' }}>not shown</p>
          </>
        )}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Please refresh')
    expect(await announcements()).toEqual(['assertive: Please refresh'])
    await view.unmount()
  })

  it('given the app passes a ref that returns a cleanup, then the cleanup runs when the notice leaves', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)
    const log: string[] = []

    const view = await render(
      <UpdateNotice.Root
        updates={updates}
        ref={node => {
          log.push(`attach:${node?.dataset['attention']}`)

          return () => {
            log.push('cleanup')
          }
        }}
      >
        {() => <p>Please refresh</p>}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Please refresh')
    await view.unmount()

    expect(log.at(-1)).toBe('cleanup')
    expect(log).not.toContain('attach:undefined')
  })

  it('given something removed the live regions while wording was waiting, then they are made again and the notice is announced', async () => {
    const tab = createTestTab()
    tab.deploy({ ...older, buildTime: new Date(tab.now()).toISOString() })
    const updates = createAppUpdates({ running: runningBuild, versionUrl }, tab)

    const view = await render(
      <UpdateNotice.Root updates={updates}>
        {() => <Wording />}
      </UpdateNotice.Root>,
    )

    await tab.advance(0)
    await expect.element(view.getByText('Please refresh')).toBeVisible()
    document
      .querySelectorAll('[data-usher-announcer]')
      .forEach(region => region.remove())
    await view.getByRole('button', { name: 'Block' }).click()

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Save your work first')
    expect(document.querySelectorAll('[data-usher-announcer]')).toHaveLength(2)
    await view.unmount()
  })
})
