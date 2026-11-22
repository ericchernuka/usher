import type { HtmlTagDescriptor } from 'vite'
import { deployUrl } from './dev-server'
import type { DeployMode } from './simulated-deploy'

export function installDevtools(endpoint: string): void {
  async function deploy(request: { mode?: DeployMode } = {}) {
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

export const devtoolsTags = (base: string): Array<HtmlTagDescriptor> => [
  {
    tag: 'script',
    children: `(${installDevtools.toString()})(${JSON.stringify(deployUrl(base))});`,
    injectTo: 'head',
  },
]
