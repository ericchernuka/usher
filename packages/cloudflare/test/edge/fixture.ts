import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { appVersion } from '@app-version/vite'
import { cloudflarePages, cloudflareWorkers } from '../../src/index.ts'

export async function buildEdgeFixture(target: 'pages' | 'workers') {
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
      appVersion({
        version: `sha-${target}`,
        skewProtection:
          target === 'pages' ? cloudflarePages() : cloudflareWorkers(),
      }),
    ],
  })
  const dist = join(root, 'dist')
  const currentAsset = `/assets/${readdirSync(join(dist, 'assets')).find(f => f.endsWith('.js'))}`

  return {
    root,
    dist,
    currentAsset,
    worker:
      target === 'pages'
        ? join(dist, '_worker.js')
        : join(root, 'dist-worker/index.js'),
  }
}
