import type { HtmlTagDescriptor } from 'vite'
import { DEPLOY_PATH } from './dev-server'

/**
 * Installs `__USHER_DEVTOOLS__` in the page. The plugin inlines this function's
 * source text into the dev server's `index.html`, so it must not import or
 * reference anything outside its own body.
 */
export function installDevtools(endpoint: string): void {
  async function deploy(
    request: { mode?: 'advance' | 'force' | 'rollback' | 'reset' } = {},
  ) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: request.mode ?? 'advance' }),
    })

    if (!response.ok) {
      throw new Error(
        `[usher] deploy failed with ${response.status}: ${await response.text()}`,
      )
    }

    return response.json()
  }

  Object.assign(globalThis, { __USHER_DEVTOOLS__: { deploy } })
}

/** A classic script in the page head that installs the devtools under `base`. */
export const devtoolsTags = (base: string): Array<HtmlTagDescriptor> => [
  {
    tag: 'script',
    children: `(${installDevtools.toString()})(${JSON.stringify(base + DEPLOY_PATH)});`,
    injectTo: 'head',
  },
]
