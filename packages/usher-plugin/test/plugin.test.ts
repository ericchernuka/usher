import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, createLogger, createServer, type InlineConfig } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { resolveBuildFacts } from '../src/build-facts'
import { versionMiddleware } from '../src/dev-server'
import {
  usher,
  type SkewProtectionAdapter,
  type SkewProtectionFiles,
} from '../src/vite'

describe('resolveBuildFacts', () => {
  it('prefers env and normalizes dates', () => {
    const info = resolveBuildFacts(
      { commitTime: '2026-11-11T09:00:00-06:00' },
      {
        env: {
          GITHUB_SHA: 'abc123',
          APP_FORCE_UPDATE_BUILT_BEFORE: '2026-11-11T10:00:00Z',
        },
        now: new Date('2026-11-11T16:00:00Z'),
      },
    )

    expect(info).toEqual({
      version: 'abc123',
      commitTime: '2026-11-11T15:00:00.000Z',
      buildTime: '2026-11-11T16:00:00.000Z',
      forceUpdateBuiltBefore: '2026-11-11T10:00:00.000Z',
    })
  })
})

describe('usher plugin', () => {
  it('emits version.json matching the virtual module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usher-'))
    writeFileSync(
      join(root, 'index.html'),
      `<script type="module" src="/main.js"></script>`,
    )
    writeFileSync(
      join(root, 'main.js'),
      `import { runningBuild, versionUrl } from "virtual:usher";\nwindow.__v = [runningBuild.version, versionUrl];`,
    )

    await build({
      root,
      base: '/app/',
      logLevel: 'silent',
      plugins: [
        usher({
          version: 'sha-test',
          commitTime: '2026-11-11T09:00:00Z',
        }),
      ],
    })

    const json = JSON.parse(
      readFileSync(join(root, 'dist/version.json'), 'utf8'),
    )

    expect(json).toMatchObject({
      version: 'sha-test',
      commitTime: '2026-11-11T09:00:00.000Z',
    })

    const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
    const js = html.match(/src="\/app\/(assets\/[^"]+\.js)"/)?.[1]

    if (!js) {
      throw new Error('index.html has no script tag')
    }

    const bundle = readFileSync(join(root, 'dist', js), 'utf8')

    for (const fact of Object.values(json)) {
      expect(bundle).toContain(fact)
    }

    expect(bundle).toContain('/app/version.json')
  })
})

it('reports a missing commit time through the build logger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usher-warning-'))
  writeFileSync(join(root, 'index.html'), '<main>App</main>')
  vi.stubEnv('PATH', '/nonexistent')
  vi.stubEnv('APP_COMMIT_TIME', '')
  const logger = createLogger('warn')
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

  await build({
    root,
    customLogger: logger,
    plugins: [usher({ version: 'test' })],
  })

  expect(warn).toHaveBeenCalledWith(expect.stringContaining('no commit time'))
})

it('warns that a relative base resolves the version file from the page URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usher-relative-'))
  writeFileSync(join(root, 'index.html'), '<main>App</main>')
  const logger = createLogger('warn')
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

  await build({
    root,
    base: './',
    customLogger: logger,
    plugins: [usher({ version: 'test', commitTime: '2026-11-11T09:00:00Z' })],
  })

  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('base "./" is relative'),
  )
})

it('serves the version file from the dev server, uncached', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usher-dev-'))
  writeFileSync(join(root, 'index.html'), '<main>App</main>')

  const server = await createServer({
    root,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [
      usher({ version: 'sha-dev', commitTime: '2026-11-11T09:00:00Z' }),
    ],
  })

  try {
    await server.listen()
    const res = await fetch(`${server.resolvedUrls?.local[0]}version.json`)

    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ version: 'sha-dev' })
  } finally {
    await server.close()
  }
})

const stub = (files: SkewProtectionFiles): SkewProtectionAdapter => ({
  name: 'stub-host',
  files: clientBuild => ({
    ...files,
    clientFiles: [
      { fileName: 'build.json', source: JSON.stringify(clientBuild) },
      ...(files.clientFiles ?? []),
    ],
  }),
})

async function buildWith(
  adapter: SkewProtectionAdapter,
  config: InlineConfig = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'usher-stub-')))
  writeFileSync(join(root, 'index.html'), '<main>App</main>')
  writeFileSync(join(root, 'server.js'), 'export default 1\n')

  await build({
    root,
    base: '/app/',
    logLevel: 'silent',
    ...config,
    plugins: [
      usher({
        version: 'test',
        commitTime: '2026-11-11T09:00:00Z',
        adapter,
      }),
    ],
  })

  return root
}

describe('given a skew-protection adapter', () => {
  it('when the client is built, then it describes the build to the adapter and emits its client files', async () => {
    const root = await buildWith(
      stub({
        clientFiles: [{ fileName: '_host/routes.txt', source: 'routes' }],
      }),
    )

    expect(readFileSync(join(root, 'dist/_host/routes.txt'), 'utf8')).toBe(
      'routes',
    )
    expect(
      JSON.parse(readFileSync(join(root, 'dist/build.json'), 'utf8')),
    ).toEqual({ base: '/app/', assetsPrefix: '/app/assets/', root })
  })

  it('when the adapter has private files, then they are written relative to the root, outside outDir', async () => {
    const root = await buildWith(
      stub({
        privateFiles: [{ fileName: 'edge/worker.js', source: 'worker' }],
      }),
    )

    expect(readFileSync(join(root, 'edge/worker.js'), 'utf8')).toBe('worker')
    expect(existsSync(join(root, 'dist/edge'))).toBe(false)
  })

  it('when a private file would land inside outDir, then the build fails naming the adapter and the file', async () => {
    await expect(
      buildWith(
        stub({ privateFiles: [{ fileName: 'dist/worker.js', source: '' }] }),
      ),
    ).rejects.toThrow(/stub-host: "dist\/worker\.js" must be outside outDir/)
  })

  it('when the adapter returns warnings, then they reach the build logger with its name', async () => {
    const logger = createLogger('warn')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await buildWith(stub({ warnings: ['check your routes'] }), {
      customLogger: logger,
    })

    expect(warn).toHaveBeenCalledWith('[usher] stub-host: check your routes')
  })

  it('when the app is built for SSR, then neither version.json nor anything from the adapter is written', async () => {
    const root = await buildWith(
      stub({
        privateFiles: [{ fileName: 'edge/worker.js', source: 'worker' }],
      }),
      { build: { ssr: 'server.js' } },
    )

    const emitted = readdirSync(join(root, 'dist'))
    expect(emitted).not.toHaveLength(0)
    expect(emitted).not.toContain('version.json')
    expect(emitted).not.toContain('build.json')
    expect(existsSync(join(root, 'edge/worker.js'))).toBe(false)
  })
})

describe('given CI variables', () => {
  it('when some are empty, then they count as missing and an explicit commit time is used', () => {
    const info = resolveBuildFacts(
      {},
      {
        env: { APP_VERSION: '', GITHUB_SHA: 'abc', APP_COMMIT_TIME: '' },
        now: new Date('2026-11-11T16:00:00Z'),
      },
    )

    expect(info.version).toBe('abc')

    const explicit = resolveBuildFacts(
      {},
      { env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' } },
    )

    expect(explicit.commitTime).toBe('2026-11-10T00:00:00.000Z')
  })
})

describe('given a malformed timestamp', () => {
  it('when APP_COMMIT_TIME is not ISO 8601, then the build fails naming the variable', () => {
    expect(() =>
      resolveBuildFacts(
        {},
        { env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: 'last tuesday' } },
      ),
    ).toThrow(
      /APP_COMMIT_TIME must be an ISO 8601 timestamp, got "last tuesday"/,
    )
  })

  it('when the forceUpdateBuiltBefore option is malformed, then the build fails naming the option', () => {
    expect(() =>
      resolveBuildFacts(
        { forceUpdateBuiltBefore: '2026-13-45' },
        { env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' } },
      ),
    ).toThrow(/forceUpdateBuiltBefore must be an ISO 8601 timestamp/)
  })

  it('when forceUpdateBuiltBefore is later than the build itself, then the build fails, because no refresh could satisfy it', () => {
    expect(() =>
      resolveBuildFacts(
        { forceUpdateBuiltBefore: '2026-11-12T09:00:00Z' },
        {
          env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' },
          now: new Date('2026-11-11T16:00:00Z'),
        },
      ),
    ).toThrow(/forceUpdateBuiltBefore .* is later than this build/)
  })

  it('when a value is only whitespace, then it counts as unset', () => {
    const info = resolveBuildFacts(
      { version: '  ' },
      { env: { GITHUB_SHA: ' abc ', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' } },
    )

    expect(info.version).toBe('abc')
  })
})

function devHandler(base: string) {
  const handler = versionMiddleware(base, 'version.json', {
    version: 'sha-dev',
    commitTime: '2026-11-11T09:00:00.000Z',
    buildTime: '2026-11-11T09:00:00.000Z',
  })

  return (url?: string) => {
    let body: string | undefined
    let passed = false
    handler(
      url === undefined ? {} : { url },
      { setHeader: () => {}, end: b => (body = b) },
      () => (passed = true),
    )

    return passed ? 'next' : JSON.parse(body!).version
  }
}

describe('dev server middleware', () => {
  it.each([
    ['/', '/version.json', '/assets/version.json'],
    ['/app/', '/app/version.json?t=1', '/version.json'],
    ['https://cdn.example.com/app/', '/app/version.json', '/version.json'],
    ['./', '/deep/route/version.json', '/version.jsonx'],
  ])('base %s serves %s and passes %s through', (base, hit, miss) => {
    const request = devHandler(base)
    expect(request(hit)).toBe('sha-dev')
    expect(request(miss)).toBe('next')
  })
  it('given a request without a url, then the middleware passes it through', () => {
    expect(devHandler('/')()).toBe('next')
  })
})

describe('given no git and no environment', () => {
  it('when the version is resolved, then it falls back to a dev version and warns about the commit time', () => {
    vi.stubEnv('PATH', '/nonexistent')
    const warn = vi.fn<() => void>()
    const now = new Date('2026-11-11T16:00:00Z')

    const info = resolveBuildFacts({}, { env: {}, now, warn })

    expect(info).toEqual({
      version: `dev-${now.getTime()}`,
      commitTime: '2026-11-11T16:00:00.000Z',
      buildTime: '2026-11-11T16:00:00.000Z',
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no commit time'))
    vi.unstubAllEnvs()
  })
})

describe('given a module the plugin does not own', () => {
  it('when the app imports it next to the virtual module, then it bundles normally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'usher-dep-'))
    writeFileSync(
      join(root, 'index.html'),
      '<script type="module" src="/main.js"></script>',
    )
    writeFileSync(
      join(root, 'dep.js'),
      'export const greeting = "hello-from-dep"\n',
    )
    writeFileSync(
      join(root, 'main.js'),
      'import { runningBuild } from "virtual:usher"\nimport { greeting } from "./dep.js"\nwindow.__v = [runningBuild.version, greeting]\n',
    )

    await build({
      root,
      logLevel: 'silent',
      plugins: [
        usher({ version: 'sha-test', commitTime: '2026-11-11T09:00:00Z' }),
      ],
    })

    const assets = join(root, 'dist/assets')

    const bundle = readdirSync(assets)
      .map(file => readFileSync(join(assets, file), 'utf8'))
      .join('')

    expect(bundle).toContain('hello-from-dep')
    expect(bundle).toContain('sha-test')
  })
})
