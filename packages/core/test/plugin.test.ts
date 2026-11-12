import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, createLogger } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { appVersion, resolveVersionInfo } from '../src/vite'

describe('resolveVersionInfo', () => {
  it('prefers env and normalizes dates', () => {
    const info = resolveVersionInfo(
      { commitTime: '2026-11-11T09:00:00-06:00' },
      {
        env: {
          GITHUB_SHA: 'abc123',
          APP_FORCE_UPDATE_BEFORE: '2026-11-11T10:00:00Z',
        },
        now: new Date('2026-11-11T16:00:00Z'),
      },
    )

    expect(info).toEqual({
      version: 'abc123',
      commitTime: '2026-11-11T15:00:00.000Z',
      builtAt: '2026-11-11T16:00:00.000Z',
      forceUpdateBefore: '2026-11-11T10:00:00.000Z',
    })
  })
})

describe('appVersion plugin', () => {
  it('emits version.json matching the virtual module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-version-'))
    writeFileSync(
      join(root, 'index.html'),
      `<script type="module" src="/main.js"></script>`,
    )
    writeFileSync(
      join(root, 'main.js'),
      `import { appVersion, versionUrl } from "virtual:app-version";\nwindow.__v = [appVersion.version, versionUrl];`,
    )

    await build({
      root,
      base: '/app/',
      logLevel: 'silent',
      plugins: [
        appVersion({ version: 'sha-test', commitTime: '2026-11-11T09:00:00Z' }),
      ],
    })

    const json = JSON.parse(
      readFileSync(join(root, 'dist/version.json'), 'utf8'),
    )

    expect(json.version).toBe('sha-test')

    const html = readFileSync(join(root, 'dist/index.html'), 'utf8')
    const js = html.match(/src="\/app\/(assets\/[^"]+\.js)"/)?.[1]

    if (!js) {
      throw new Error('index.html has no script tag')
    }

    const bundle = readFileSync(join(root, 'dist', js), 'utf8')
    expect(bundle).toContain('sha-test')
    expect(bundle).toContain('/app/version.json')
  })
})

describe('plugin and edge (first review #12)', () => {
  it('treats empty CI variables as missing and warns when commit time is unknown', async () => {
    const warn = vi.fn<() => void>()

    const info = resolveVersionInfo(
      {},
      {
        env: { APP_VERSION: '', GITHUB_SHA: 'abc', APP_COMMIT_TIME: '' },
        now: new Date('2026-11-11T16:00:00Z'),
        warn,
      },
    )

    expect(info.version).toBe('abc')

    // This repo has .git, so commit time comes from git; simulate its absence via APP_COMMIT_TIME.
    const explicit = resolveVersionInfo(
      {},
      { env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' } },
    )

    expect(explicit.commitTime).toBe('2026-11-10T00:00:00.000Z')
  })
})

describe('given a malformed timestamp', () => {
  it('when APP_COMMIT_TIME is not ISO 8601, then the build fails naming the variable', () => {
    expect(() =>
      resolveVersionInfo(
        {},
        { env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: 'last tuesday' } },
      ),
    ).toThrow(
      /APP_COMMIT_TIME must be an ISO 8601 timestamp, got "last tuesday"/,
    )
  })

  it('when the forceUpdateBefore option is malformed, then the build fails naming the option', () => {
    expect(() =>
      resolveVersionInfo(
        { forceUpdateBefore: '2026-13-45' },
        { env: { GITHUB_SHA: 'abc', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' } },
      ),
    ).toThrow(/forceUpdateBefore must be an ISO 8601 timestamp/)
  })

  it('when a value is only whitespace, then it counts as unset', () => {
    const info = resolveVersionInfo(
      { version: '  ' },
      { env: { GITHUB_SHA: ' abc ', APP_COMMIT_TIME: '2026-11-10T00:00:00Z' } },
    )

    expect(info.version).toBe('abc')
  })
})

describe('dev server middleware', () => {
  type Handler = (
    req: { url?: string },
    res: { setHeader(k: string, v: string): void; end(b: string): void },
    next: () => void,
  ) => void

  function devHandler(base: string) {
    const plugin = appVersion({
      version: 'sha-dev',
      commitTime: '2026-11-11T09:00:00Z',
    })

    const config = {
      base,
      root: '/',
      build: { assetsDir: 'assets', outDir: 'dist', ssr: false },
      logger: createLogger('silent'),
    }

    plugin.configResolved(config)

    let handler: Handler | undefined

    plugin.configureServer({
      middlewares: { use: (fn: Handler) => (handler = fn) },
    })

    return (url?: string) => {
      let body: string | undefined
      let passed = false
      handler!(
        url === undefined ? {} : { url },
        { setHeader: () => {}, end: b => (body = b) },
        () => (passed = true),
      )

      return passed ? 'next' : JSON.parse(body!).version
    }
  }

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
    vi.stubEnv('PATH', '/nonexistent') // `git` can't be found
    const warn = vi.fn<() => void>()
    const now = new Date('2026-11-11T16:00:00Z')

    const info = resolveVersionInfo({}, { env: {}, now, warn })

    expect(info).toEqual({
      version: `dev-${now.getTime()}`,
      commitTime: '2026-11-11T16:00:00.000Z',
      builtAt: '2026-11-11T16:00:00.000Z',
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no commit time'))
    vi.unstubAllEnvs()
  })
})

describe('given a server-side build', () => {
  it('when the app is built for SSR, then no version.json is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-version-ssr-'))
    writeFileSync(join(root, 'server.js'), 'export default 1\n')

    await build({
      root,
      logLevel: 'silent',
      build: { ssr: 'server.js' },
      plugins: [
        appVersion({ version: 'sha-test', commitTime: '2026-11-11T09:00:00Z' }),
      ],
    })

    const emitted = readdirSync(join(root, 'dist'))
    expect(emitted).not.toHaveLength(0) // the server bundle was built
    expect(emitted).not.toContain('version.json')
  })
})

describe('given a module the plugin does not own', () => {
  it('when the app imports it next to the virtual module, then it bundles normally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-version-dep-'))
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
      'import { appVersion } from "virtual:app-version"\nimport { greeting } from "./dep.js"\nwindow.__v = [appVersion.version, greeting]\n',
    )

    await build({
      root,
      logLevel: 'silent',
      plugins: [
        appVersion({ version: 'sha-test', commitTime: '2026-11-11T09:00:00Z' }),
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
