import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import type { BuildFacts } from '@rndsqr/usher-core'
import { installDevtools } from '../src/devtools'
import { simulatedBuild } from '../src/simulated-deploy'
import { usher, type UsherPluginOptions } from '../src/vite'

interface Devtools {
  deploy(request?: { mode?: string }): Promise<BuildFacts>
}

interface PageScope {
  fetch(path: string, init?: RequestInit): Promise<Response>
}

const devtoolsIn = (scope: PageScope): Devtools =>
  Object.getOwnPropertyDescriptor(scope, '__USHER_DEVTOOLS__')?.value

const real: BuildFacts = {
  version: 'sha-real',
  commitTime: '2026-11-10T09:00:00.000Z',
  buildTime: '2026-11-11T09:00:00.000Z',
}

const later = new Date('2026-11-11T10:00:00.000Z')

describe('simulatedBuild', () => {
  it('given advance, then it serves a new version built now from the same commit', () => {
    expect(
      simulatedBuild(real, { mode: 'advance', sequence: 1 }, later),
    ).toEqual({
      version: 'sha-real-dev-1',
      commitTime: real.commitTime,
      buildTime: later.toISOString(),
    })
  })

  it('given force, then the cutoff is the new build time', () => {
    expect(simulatedBuild(real, { mode: 'force', sequence: 2 }, later)).toEqual(
      {
        version: 'sha-real-dev-2',
        commitTime: real.commitTime,
        buildTime: later.toISOString(),
        forceUpdateBuiltBefore: later.toISOString(),
      },
    )
  })

  it('given force in the same millisecond as the real build, then the cutoff still supersedes the real build', () => {
    const forced = simulatedBuild(
      real,
      { mode: 'force', sequence: 1 },
      new Date(real.buildTime),
    )

    const cutoff = Date.parse(forced.forceUpdateBuiltBefore ?? '')

    expect(cutoff).toBeGreaterThan(Date.parse(real.buildTime))
    expect(cutoff).toBeLessThanOrEqual(Date.parse(forced.buildTime))
  })

  it('given rollback, then the commit is older than the real one and there is no cutoff', () => {
    const rollback = simulatedBuild(
      real,
      { mode: 'rollback', sequence: 3 },
      later,
    )

    expect(rollback).toEqual({
      version: 'sha-real-dev-3',
      commitTime: '2026-11-10T08:59:59.000Z',
      buildTime: later.toISOString(),
    })
  })

  it('given a real build with its own cutoff, then a simulated advance does not carry it', () => {
    const advanced = simulatedBuild(
      { ...real, forceUpdateBuiltBefore: real.buildTime },
      { mode: 'advance', sequence: 1 },
      later,
    )

    expect(advanced).not.toHaveProperty('forceUpdateBuiltBefore')
  })
})

const servers: Array<{ close(): Promise<void> }> = []

async function startServer(config: { base: string; devtools?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'usher-devtools-'))
  writeFileSync(
    join(root, 'index.html'),
    '<html><head></head><main>App</main></html>',
  )

  const options: UsherPluginOptions = {
    version: 'sha-dev',
    commitTime: '2026-11-11T09:00:00Z',
  }

  if (config.devtools) {
    options.devtools = true
  }

  const server = await createServer({
    root,
    base: config.base,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [usher(options)],
  })

  servers.push(server)
  await server.listen()
  const url = server.resolvedUrls?.local[0] ?? ''

  return {
    url,
    served: async (): Promise<BuildFacts> =>
      (await fetch(`${url}version.json?t=1`)).json(),
    deploy: (body: string) =>
      fetch(`${url}__usher/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  Reflect.deleteProperty(globalThis, '__USHER_DEVTOOLS__')
})

describe('given devtools on the dev server', () => {
  it('when a deploy is posted, then the version URL serves the build it answered with', async () => {
    const dev = await startServer({ base: '/', devtools: true })
    const before = await dev.served()

    const response = await dev.deploy('{"mode":"advance"}')
    const deployed = await response.json()

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(deployed.version).not.toBe(before.version)
    expect(await dev.served()).toEqual(deployed)
  })

  it('when deploys repeat, then each one serves a distinct version', async () => {
    const dev = await startServer({ base: '/', devtools: true })

    const first = await (await dev.deploy('{"mode":"advance"}')).json()
    const second = await (await dev.deploy('{"mode":"advance"}')).json()

    expect(second.version).not.toBe(first.version)
  })

  it('when a rollback follows a forced update, then no cutoff carries over, and reset serves the real build', async () => {
    const dev = await startServer({ base: '/', devtools: true })
    const before = await dev.served()

    await dev.deploy('{"mode":"force"}')
    const rollback = await (await dev.deploy('{"mode":"rollback"}')).json()

    expect(rollback).not.toHaveProperty('forceUpdateBuiltBefore')

    await dev.deploy('{"mode":"reset"}')

    expect(await dev.served()).toEqual(before)
  })

  it.each(['{"mode":"sideways"}', 'not json', ''])(
    'when the body is %j, then it answers 400 naming the modes and serves the same build',
    async body => {
      const dev = await startServer({ base: '/', devtools: true })
      const before = await dev.served()

      const response = await dev.deploy(body)

      expect(response.status).toBe(400)
      expect(await response.text()).toContain('advance, force, rollback, reset')
      expect(await dev.served()).toEqual(before)
    },
  )

  it('when the endpoint is read with GET, then it answers 405', async () => {
    const dev = await startServer({ base: '/', devtools: true })

    const response = await fetch(`${dev.url}__usher/deploy`)

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('when the deploy is not sent as JSON, as a form on another site would send it, then it answers 415 and serves the same build', async () => {
    const dev = await startServer({ base: '/', devtools: true })
    const before = await dev.served()

    const response = await fetch(`${dev.url}__usher/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"mode":"force"}',
    })

    expect(response.status).toBe(415)
    expect(await dev.served()).toEqual(before)
  })

  it('when base is not the root, then the script in the page deploys through the endpoint under it', async () => {
    const dev = await startServer({ base: '/app/', devtools: true })
    const before = await dev.served()
    const html = await (await fetch(dev.url)).text()
    const script = html.match(/<script>(.*?)<\/script>/s)?.[1] ?? ''

    const page: PageScope = {
      fetch: (path: string, init?: RequestInit) =>
        fetch(new URL(path, dev.url), init),
    }

    runInNewContext(script, page)
    const deployed = await devtoolsIn(page).deploy()

    expect(dev.url).toMatch(/\/app\/$/)
    expect(deployed.version).not.toBe(before.version)
    expect(await dev.served()).toEqual(deployed)
  })
})

describe('given the page global', () => {
  it('when deploy is called, then it resolves with the build the server now serves', async () => {
    const dev = await startServer({ base: '/', devtools: true })
    const before = await dev.served()
    installDevtools(`${dev.url}__usher/deploy`)

    const advanced = await devtoolsIn(globalThis).deploy()
    expect(advanced.version).not.toBe(before.version)
    expect(advanced.forceUpdateBuiltBefore).toBeUndefined()
    expect(await dev.served()).toEqual(advanced)

    const forced = await devtoolsIn(globalThis).deploy({
      mode: 'force',
    })

    expect(forced.forceUpdateBuiltBefore).toBe(forced.buildTime)

    await devtoolsIn(globalThis).deploy({ mode: 'reset' })
    expect(await dev.served()).toEqual(before)
  })

  it('when the server refuses, then deploy rejects with the status', async () => {
    const dev = await startServer({ base: '/', devtools: true })
    installDevtools(`${dev.url}__usher/deploy`)

    await expect(
      devtoolsIn(globalThis).deploy({ mode: 'sideways' }),
    ).rejects.toThrow(/deploy failed with 400/)
  })
})

describe('given devtools are off', () => {
  it('when a deploy is posted, then nothing handles it and the page has no global', async () => {
    const dev = await startServer({ base: '/' })
    const before = await dev.served()

    const response = await dev.deploy('{"mode":"advance"}')
    const html = await (await fetch(dev.url)).text()

    expect(response.status).toBe(404)
    expect(await dev.served()).toEqual(before)
    expect(html).not.toContain('__USHER_DEVTOOLS__')
  })
})

function filesUnder(directory: string): Array<string> {
  return readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  }).flatMap(entry =>
    entry.isFile() ? [join(entry.parentPath, entry.name)] : [],
  )
}

describe('given devtools in a production build', () => {
  it('when the app is built, then no output mentions the global and version.json holds the real build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usher-devtools-build-'))
    writeFileSync(
      join(root, 'index.html'),
      '<html><head></head><script type="module" src="/main.js"></script></html>',
    )
    writeFileSync(
      join(root, 'main.js'),
      'import { runningBuild } from "virtual:usher"\nwindow.__v = runningBuild\n',
    )

    await build({
      root,
      logLevel: 'silent',
      plugins: [
        usher({
          version: 'sha-prod',
          commitTime: '2026-11-11T09:00:00Z',
          devtools: true,
        }),
      ],
    })

    const output = filesUnder(join(root, 'dist'))

    expect(output.length).toBeGreaterThan(2)

    for (const file of output) {
      expect(readFileSync(file, 'utf8')).not.toContain('__USHER_DEVTOOLS__')
      expect(readFileSync(file, 'utf8')).not.toContain('__usher/deploy')
    }

    expect(
      JSON.parse(readFileSync(join(root, 'dist/version.json'), 'utf8')),
    ).toMatchObject({ version: 'sha-prod' })
  })
})
