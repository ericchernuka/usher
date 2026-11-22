import { virtual } from '@guidepup/virtual-screen-reader'
import {
  createAppUpdates,
  type AppUpdates,
  type UpdateNotice as Notice,
} from '@rndsqr/usher-core'
import { createTestTab } from '@rndsqr/usher-core/testing'
import { useState } from 'react'
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

function served(build: typeof newer, storageKey = 'usher') {
  const tab = createTestTab()
  tab.deploy({ ...build, buildTime: new Date(tab.now()).toISOString() })

  const updates = createAppUpdates(
    { running: runningBuild, versionUrl, storageKey },
    tab,
  )

  return { tab, updates }
}

const wordingFor = (notice: Notice) => `Update available: ${notice.attention}`

interface BannerProps {
  updates: AppUpdates
  minAttention?: 'passive'
  announcement?: (notice: Notice) => string
}

function Banner({ announcement = wordingFor, ...props }: BannerProps) {
  return (
    <UpdateNotice.Root {...props} announcement={announcement}>
      {notice => (
        <>
          <p>{announcement(notice)}</p>
          <UpdateNotice.Refresh>Refresh</UpdateNotice.Refresh>
          <UpdateNotice.Close>Close</UpdateNotice.Close>
        </>
      )}
    </UpdateNotice.Root>
  )
}

function Rewordable({ updates }: { updates: AppUpdates }) {
  const [blocked, setBlocked] = useState(false)

  return (
    <>
      <Banner
        updates={updates}
        announcement={() =>
          blocked ? 'Save your work first' : 'Please refresh'
        }
      />
      <button type="button" onClick={() => setBlocked(true)}>
        Block
      </button>
    </>
  )
}

const settled = () => new Promise(resolve => setTimeout(resolve, 250))

async function announcements() {
  await settled()

  return (await virtual.spokenPhraseLog()).filter(phrase =>
    /^(polite|assertive): \S/.test(phrase),
  )
}

const regions = () => document.querySelectorAll('[data-usher-announcer]')

describe('what a screen reader hears', () => {
  it('given a passive notice, then nothing is announced', async () => {
    const { tab, updates } = served(newer)

    const view = await render(
      <Banner updates={updates} minAttention="passive" />,
    )

    await tab.advance(HOUR)

    await expect
      .element(view.getByRole('paragraph'))
      .toHaveTextContent('Update available: passive')
    expect(await announcements()).toEqual([])
    await view.unmount()
  })

  it('given a tab reaches prompt attention, then the wording is announced politely, once', async () => {
    const { tab, updates } = served(newer)
    const view = await render(<Banner updates={updates} />)
    await tab.advance(13 * HOUR)

    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    expect(await announcements()).toEqual(['polite: Update available: prompt'])
    await view.unmount()
  })

  it('given a prompt escalates to urgent, then the wording is announced again, assertively', async () => {
    const { tab, updates } = served(newer)
    const view = await render(<Banner updates={updates} />)
    await tab.advance(13 * HOUR)
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    await tab.advance(12 * HOUR)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    await expect.element(view.getByRole('status')).toHaveTextContent('')
    expect(await announcements()).toEqual([
      'polite: Update available: prompt',
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a tab passes through prompt to urgent before anything is said, then only the urgent wording is announced', async () => {
    const { tab, updates } = served(newer)
    const view = await render(<Banner updates={updates} />)
    await tab.advance(25 * HOUR)

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')
    expect(await announcements()).toEqual([
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a prompt is closed, then its wording leaves the region and nothing more is said', async () => {
    const { tab, updates } = served(newer)
    const view = await render(<Banner updates={updates} />)
    await tab.advance(13 * HOUR)
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    await view.getByRole('button', { name: 'Close' }).click()

    await expect.element(view.getByRole('status')).toHaveTextContent('')
    expect(await announcements()).toEqual(['polite: Update available: prompt'])
    await view.unmount()
  })

  it('given the wording changes while the notice stays, then the new wording is announced and the old leaves', async () => {
    const { tab, updates } = served(older)
    const view = await render(<Rewordable updates={updates} />)
    await tab.advance(0)
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Please refresh')
    await view.getByRole('button', { name: 'Block' }).click()

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Save your work first')
    await settled()
    expect(view.getByRole('alert').element().textContent).toBe(
      'Save your work first',
    )
    expect(await announcements()).toEqual([
      'assertive: Please refresh',
      'assertive: Save your work first',
    ])
    await view.unmount()
  })

  it('given two notices with the same wording, when the second mounts late and then leaves, then the wording is announced once and stays', async () => {
    const { tab, updates } = served(older)
    const view = await render(<Banner updates={updates} />)
    await tab.advance(0)
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Update available: urgent')

    await view.rerender(
      <>
        <Banner updates={updates} />
        <Banner updates={updates} minAttention="passive" />
      </>,
    )
    await settled()
    await view.rerender(<Banner updates={updates} />)

    await settled()
    expect(view.getByRole('alert').element().textContent).toBe(
      'Update available: urgent',
    )
    expect(await announcements()).toEqual([
      'assertive: Update available: urgent',
    ])
    await view.unmount()
  })

  it('given a notice leaves before its wording is announced, then only the notice that stays is announced', async () => {
    const { tab, updates } = served(older)
    const staying = <Banner updates={updates} announcement={() => 'Stays'} />

    const view = await render(
      <>
        {staying}
        <Banner updates={updates} announcement={() => 'Leaves'} />
      </>,
    )

    await tab.advance(0)
    await expect.element(view.getByText('Leaves')).toBeVisible()
    await view.rerender(staying)

    await expect.element(view.getByRole('alert')).toHaveTextContent('Stays')
    await settled()
    expect(view.getByRole('alert').element().textContent).toBe('Stays')
    expect(await announcements()).toEqual(['assertive: Stays'])
    await view.unmount()
  })

  it('given one app is urgent while another prompts, then each is announced at its own politeness', async () => {
    const urgent = served(older)
    const prompting = served(newer, 'billing')

    const view = await render(
      <>
        <Banner updates={urgent.updates} announcement={() => 'Refresh now'} />
        <Banner
          updates={prompting.updates}
          announcement={() => 'An update is ready'}
        />
      </>,
    )

    await Promise.all([urgent.tab.advance(0), prompting.tab.advance(13 * HOUR)])

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Refresh now')
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('An update is ready')
    await view.unmount()
  })

  it('given no wording, then nothing is announced', async () => {
    const { tab, updates } = served(older)

    const view = await render(
      <Banner updates={updates} announcement={() => ''} />,
    )

    await tab.advance(0)
    await expect.poll(() => updates.state.get().attention).toBe('urgent')

    expect(await announcements()).toEqual([])
    await view.unmount()
  })

  it('given something removed one live region, then it is made again without repeating what the other said', async () => {
    const prompting = served(newer, 'billing')
    const urgent = served(older)

    const view = await render(
      <>
        <Banner
          updates={prompting.updates}
          announcement={() => 'An update is ready'}
        />
        <Rewordable updates={urgent.updates} />
      </>,
    )

    await Promise.all([urgent.tab.advance(0), prompting.tab.advance(13 * HOUR)])
    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('An update is ready')
    const polite = view.getByRole('status').element()
    document.querySelector('[data-usher-announcer="assertive"]')?.remove()
    await view.getByRole('button', { name: 'Block' }).click()

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Save your work first')
    expect(regions()).toHaveLength(2)
    expect(view.getByRole('status').element()).toBe(polite)
    expect(
      (await announcements()).filter(phrase => phrase.startsWith('polite')),
    ).toEqual(['polite: An update is ready'])
    await view.unmount()
  })

  it('given two notices exchange their wording in one render, then both stay in the region and nothing is said again', async () => {
    const { tab, updates } = served(older)

    const pair = (first: string, second: string) => (
      <>
        <Banner updates={updates} announcement={() => first} />
        <Banner updates={updates} announcement={() => second} />
      </>
    )

    const view = await render(pair('One', 'Two'))
    await tab.advance(0)
    await expect.element(view.getByRole('alert')).toHaveTextContent('OneTwo')
    const said = Array.from(view.getByRole('alert').element().children)

    await view.rerender(pair('Two', 'One'))
    await settled()

    expect(Array.from(view.getByRole('alert').element().children)).toEqual(said)
    expect(await announcements()).toEqual(['assertive: One', 'assertive: Two'])
    await view.unmount()
  })

  it('given a notice inside an open modal dialog, then it is announced from inside the dialog, and from the page again once the dialog has closed', async () => {
    const { tab, updates } = served(newer)

    const view = await render(
      <dialog>
        <Banner updates={updates} />
      </dialog>,
    )

    const dialog = view.container.querySelector('dialog')
    dialog?.showModal()
    await tab.advance(13 * HOUR)

    await expect
      .element(view.getByRole('status'))
      .toHaveTextContent('Update available: prompt')
    expect(dialog?.contains(view.getByRole('status').element())).toBe(true)

    dialog?.close()
    await tab.advance(12 * HOUR)

    await expect.poll(() => updates.state.get().attention).toBe('urgent')
    await expect
      .poll(() => regions()[1]?.textContent)
      .toBe('Update available: urgent')
    expect(Array.from(regions(), region => region.parentElement)).toEqual([
      document.body,
      document.body,
    ])
    await view.unmount()
  })
})
