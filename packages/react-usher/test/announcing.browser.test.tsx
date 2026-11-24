import { virtual } from '@guidepup/virtual-screen-reader'
import {
  createAppUpdates,
  type AppUpdates,
  type UpdateNotice as Notice,
} from '@ericchernuka/usher-core'
import { createTestTab } from '@ericchernuka/usher-core/testing'
import { useState } from 'react'
import { renderToString } from 'react-dom/server'
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

  it('given two notices for one update, when only one is given wording, then the update is announced once', async () => {
    const { tab, updates } = served(older)

    const view = await render(
      <>
        <Banner updates={updates} />
        <Banner updates={updates} announcement={() => ''} />
      </>,
    )

    await tab.advance(0)
    await expect.poll(() => updates.state.get().attention).toBe('urgent')

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
      .poll(() => prompting.updates.state.get().attention)
      .toBe('prompt')

    expect((await announcements()).toSorted()).toEqual([
      'assertive: Refresh now',
      'polite: An update is ready',
    ])
    await view.unmount()
  })

  it('given no wording, or a root that is hidden, inert or hidden from assistive technology, then nothing is announced', async () => {
    const { tab, updates } = served(older)

    const view = await render(
      <>
        <Banner updates={updates} announcement={() => ''} />
        <UpdateNotice.Root hidden updates={updates} announcement={wordingFor}>
          {() => null}
        </UpdateNotice.Root>
        <UpdateNotice.Root
          aria-hidden="true"
          updates={updates}
          announcement={wordingFor}
        >
          {() => null}
        </UpdateNotice.Root>
        <UpdateNotice.Root inert updates={updates} announcement={wordingFor}>
          {() => null}
        </UpdateNotice.Root>
      </>,
    )

    await tab.advance(0)
    await expect.poll(() => updates.state.get().attention).toBe('urgent')

    expect(await announcements()).toEqual([])
    await view.unmount()
  })

  it('given a notice inside an open modal dialog, then its live region is inside the dialog too and the wording is announced', async () => {
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
    expect(await announcements()).toEqual(['polite: Update available: prompt'])
    dialog?.close()
    await view.unmount()
  })

  it('given the notice is rendered on a server, then its live regions take no space and carry no inline style, and are shown but unseen once mounted', async () => {
    const { updates } = served(newer)
    const markup = renderToString(<Banner updates={updates} />)

    expect(markup).toContain('role="alert"')
    expect(markup).not.toContain('style=')
    expect(markup.match(/ hidden=""/g)).toHaveLength(2)

    const view = await render(<Banner updates={updates} />)

    await expect
      .poll(() => getComputedStyle(view.getByRole('alert').element()).position)
      .toBe('fixed')
    expect(getComputedStyle(view.getByRole('status').element()).width).toBe(
      '1px',
    )
    expect(view.container.querySelectorAll('[hidden]')).toHaveLength(0)
    await view.unmount()
  })
})
