import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import PagesApp from '../../../apps/pages-react/src/App'
import WorkersApp from '../../../apps/workers-react/src/App'
import pagesHtml from '../../../apps/pages-react/index.html?raw'
import workersHtml from '../../../apps/workers-react/index.html?raw'

const latest = {
  version: 'sample-deploy',
  commitTime: '2099-01-01T00:00:00.000Z',
  builtAt: '2099-01-01T00:00:00.000Z',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each([
  { name: 'Pages', App: PagesApp, html: pagesHtml },
  { name: 'Workers', App: WorkersApp, html: workersHtml },
])(
  '$name sample displays the deployed update state',
  async ({ name, App, html }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-11T16:00:00Z'))
    localStorage.clear()

    const document = new DOMParser().parseFromString(html, 'text/html')
    expect(document.getElementById('root')).not.toBeNull()
    expect(
      document.querySelector('script[type="module"]')?.getAttribute('src'),
    ).toBe('/src/main.tsx')
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => Response.json(latest)),
    )
    const view = await render(<App />)
    await expect
      .element(view.getByRole('heading', { name: `${name} example` }))
      .toBeVisible()
    await expect.element(view.getByText('Attention: passive')).toBeVisible()
    await view.unmount()
  },
)
