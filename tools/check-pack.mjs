import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(import.meta.dirname, '..')

const packages = [
  'usher-core',
  'react-usher',
  'usher-plugin',
  'usher-cloudflare',
]

const work = mkdtempSync(join(tmpdir(), 'usher-pack-'))
const app = join(work, 'app')

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim()

const say = message => process.stdout.write(`check:pack ${message}\n`)

function pack(name) {
  const directory = join(repo, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json')))
  run('pnpm', ['pack', '--pack-destination', work], directory)

  const tarball = readdirSync(work).find(
    file => file.endsWith('.tgz') && file.includes(`-${name}-`),
  )

  assert(tarball, `no tarball was written for ${manifest.name}`)

  return { manifest, tarball: join(work, tarball) }
}

function checkContents({ manifest, tarball }) {
  const files = run('tar', ['-tzf', tarball]).split('\n')

  const unexpected = files.filter(
    file =>
      file !== 'package/package.json' &&
      file !== 'package/LICENSE' &&
      !file.startsWith('package/dist/'),
  )

  assert.deepEqual(unexpected, [], `${manifest.name} ships unexpected files`)
  assert(files.includes('package/LICENSE'), `${manifest.name} ships no LICENSE`)

  for (const [entry, target] of Object.entries(manifest.exports)) {
    const path = `package/${target.replace(/^\.\//, '')}`
    assert(files.includes(path), `${manifest.name} "${entry}" has no ${path}`)

    if (path.endsWith('.js')) {
      const types = path.replace(/\.js$/, '.d.ts')
      assert(files.includes(types), `${manifest.name} "${entry}" has no types`)
    }
  }
}

const write = (file, content) => {
  mkdirSync(resolve(app, file, '..'), { recursive: true })
  writeFileSync(join(app, file), content)
}

const appFiles = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node', 'vite/client'],
    },
    include: ['src', 'vite.config.ts'],
  }),
  'vite.config.ts': `import { cloudflarePages } from '@ericchernuka/usher-cloudflare'
import type { SkewProtectionAdapter } from '@ericchernuka/usher-plugin/adapter'
import { usher } from '@ericchernuka/usher-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const adapter: SkewProtectionAdapter = cloudflarePages()

export default defineConfig({
  plugins: [react(), usher({ version: 'pack-smoke', adapter })],
})
`,
  'index.html':
    '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'src/main.tsx': `import { connectUpdateSurface, type UpdateState } from '@ericchernuka/usher-core'
import { useRefreshBlocker, useUpdateState } from '@ericchernuka/react-usher'
import { createAppUpdates, runningBuild } from '@ericchernuka/usher-plugin/client'
import { createRoot } from 'react-dom/client'

const appUpdates = createAppUpdates({ pollInterval: 60_000 })

connectUpdateSurface(appUpdates, { show: notice => void notice.refresh, hide() {} })

function App() {
  const state: UpdateState = useUpdateState(appUpdates.state)
  useRefreshBlocker(appUpdates.refresh, false)

  return <p>{runningBuild.version}: {state.attention}</p>
}

createRoot(document.getElementById('root')!).render(<App />)
`,
  'src/worker.ts': `import { createAssetFallback, type AssetFallbackEnv } from '@ericchernuka/usher-cloudflare/worker'

const assets = createAssetFallback({ r2Binding: 'CHUNKS' })

export default {
  fetch: (request: Request, env: AssetFallbackEnv<'CHUNKS'>) => assets(request, env),
}
`,
}

function writeApp(packed) {
  const tarballs = Object.fromEntries(
    packed.map(({ manifest, tarball }) => [manifest.name, `file:${tarball}`]),
  )

  const versions = JSON.parse(
    readFileSync(join(repo, 'examples/react/cloudflare-pages/package.json')),
  )

  const version = name =>
    versions.dependencies[name] ?? versions.devDependencies[name]

  const external = Object.fromEntries(
    [
      'react',
      'react-dom',
      '@types/node',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'typescript',
      'vite',
    ].map(name => [name, version(name)]),
  )

  write(
    'package.json',
    JSON.stringify({
      name: 'pack-smoke',
      private: true,
      type: 'module',
      dependencies: { ...tarballs, ...external },
    }),
  )

  write(
    'pnpm-workspace.yaml',
    `overrides:\n${Object.entries(tarballs)
      .map(([name, path]) => `  '${name}': '${path}'\n`)
      .join('')}`,
  )

  Object.entries(appFiles).forEach(([file, content]) => write(file, content))
}

async function checkBuild() {
  run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'error'], app)

  const facts = JSON.parse(readFileSync(join(app, 'dist/version.json')))
  assert.equal(facts.version, 'pack-smoke')
  assert(existsSync(join(app, 'dist/_routes.json')), 'no _routes.json')

  const worker = await import(pathToFileURL(join(app, 'dist/_worker.js')).href)

  const response = await worker.default.fetch(
    new Request('https://app.test/assets/gone.js'),
    {
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
      CHUNK_ARCHIVE: {
        get: async () => ({
          body: 'old',
          httpEtag: '"e"',
          writeHttpMetadata() {},
        }),
      },
    },
  )

  assert.equal(await response.text(), 'old')
}

const devProbe = `import { createServer } from 'vite'

const server = await createServer({ logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
await server.listen()
const origin = server.resolvedUrls.local[0].replace(/\\/$/, '')

const get = async path => {
  const response = await fetch(origin + path)
  const body = await response.text()
  if (!response.ok) throw new Error(path + ' answered ' + response.status + ': ' + body.slice(0, 400))
  return body
}

try {
  const version = JSON.parse(await get('/version.json'))
  if (version.version !== 'pack-smoke') throw new Error('unexpected version.json')

  const entry = await get('/src/main.tsx')
  const imports = [...entry.matchAll(/from "([^"]+)"/g)].map(match => match[1])
  const client = imports.find(path => path.includes('usher-plugin'))
  if (!client) throw new Error('entry does not import the client helper: ' + imports.join(', '))

  for (const path of imports) {
    const body = await get(path)
    if (body.includes('Failed to resolve')) throw new Error(path + ' has an unresolved import')
  }

  const helper = await get(client)
  const facts = helper.match(/from "([^"]*virtual:usher[^"]*)"/)?.[1]
  if (!facts?.startsWith('/')) throw new Error('the client helper does not import the build facts from the dev server')
  if (!(await get(facts)).includes('pack-smoke')) throw new Error('the embedded build facts are missing')
} finally {
  await server.close()
}
`

try {
  run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=./packages/*'], repo)
  const packed = packages.map(pack)
  packed.forEach(checkContents)
  say(
    'tarballs contain only dist, package.json, and LICENSE, and every export exists',
  )

  writeApp(packed)
  run('pnpm', ['install', '--prefer-offline'], app)
  run('pnpm', ['exec', 'tsc'], app)
  say('types resolve from the installed packages')

  await checkBuild()
  say('production build emits version.json and a working Pages worker')

  write('dev-probe.mjs', devProbe)
  run('node', ['dev-probe.mjs'], app)
  say('dev server serves version.json and resolves the client helper')
} catch (error) {
  process.stderr.write(
    `check:pack failed: ${error.message}\n${error.stdout ?? ''}${error.stderr ?? ''}\n`,
  )
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
