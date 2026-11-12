import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { usher } from '@rndsqr/usher-plugin/vite'
import { cloudflarePages, cloudflareWorkers } from '../../src/index.ts'

const targets = {
  pages: { adapter: cloudflarePages(), worker: 'dist/_worker.js' },
  workers: { adapter: cloudflareWorkers(), worker: 'dist-worker/index.js' },
  /** The app owns its worker, so the build has no adapter. */
  composed: {
    adapter: undefined,
    worker: '../../test/edge/composed-worker.ts',
  },
}

export async function buildEdgeFixture(target: keyof typeof targets) {
  const { adapter, worker } = targets[target]
  const root = resolve(import.meta.dirname, `../../.edge-fixture/${target}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><script type="module" src="/main.js"></script>`,
  )
  writeFileSync(join(root, 'main.js'), `console.log("current build");`)
  await build({
    root,
    logLevel: 'silent',
    plugins: [
      usher({
        version: `sha-${target}`,
        ...(adapter && { adapter }),
      }),
    ],
  })
  const dist = join(root, 'dist')
  const currentAsset = `/assets/${readdirSync(join(dist, 'assets')).find(file => file.endsWith('.js'))}`

  return { dist, currentAsset, worker: resolve(root, worker) }
}
