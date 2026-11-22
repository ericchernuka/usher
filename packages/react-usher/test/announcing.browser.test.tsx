import { virtual } from '@guidepup/virtual-screen-reader'
import { createAppUpdates } from '@rndsqr/usher-core'
import { createTestTab } from '@rndsqr/usher-core/testing'
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

const announcements = async () =>
  (await virtual.spokenPhraseLog()).filter(phrase =>
    /^(polite|assertive): \S/.test(phrase),
  )

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
    await tab.advance(25 * HOUR)

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

  it('given a prompt is closed, then the announcement is cleared and nothing more is said', async () => {
    const { tab, view } = await notice(newer)
    await tab.advance(13 * HOUR)
    await view.getByRole('button', { name: 'Close' }).click()

    await expect.element(view.getByRole('status')).toHaveTextContent('')
    expect(await announcements()).toEqual(['polite: Update available: prompt'])
    await view.unmount()
  })
})
