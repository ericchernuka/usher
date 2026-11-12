import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import {
  appVersion,
  type ClientBuild,
  type SkewProtectionAdapter,
} from '@app-version/vite'
import { cloudflarePages, cloudflareWorkers } from '../src/index'

const assetsHtml = () =>
  new Response('<!doctype html>', {
    headers: { 'content-type': 'text/html' },
  })

const tempRoot = () => mkdtempSync(join(tmpdir(), 'app-version-skew-'))

const clientBuild = (base = '/', root = tempRoot()): ClientBuild => ({
  base,
  assetsPrefix: `${base}assets/`,
  root,
})

async function buildFixture(skewProtection: SkewProtectionAdapter) {
  const root = tempRoot()
  writeFileSync(
    join(root, 'index.html'),
    `<script type="module" src="/main.js"></script>`,
  )
  writeFileSync(join(root, 'main.js'), `console.log("hi")`)
  await build({
    root,
    logLevel: 'silent',
    plugins: [appVersion({ version: 'sha', skewProtection })],
  })

  return root
}

function fakeEnv(files: Record<string, string>, r2: Record<string, string>) {
  return {
    ASSETS: {
      async fetch(req: Request) {
        const path = new URL(req.url).pathname

        if (files[path]) {
          return new Response(files[path], {
            headers: { 'content-type': 'text/javascript' },
          })
        }

        return assetsHtml()
      },
    },
    BUILD_CACHE: {
      async get(key: string) {
        if (!(key in r2)) {
          return null
        }

        return {
          body: r2[key],
          httpEtag: '"etag"',
          writeHttpMetadata: (h: Headers) =>
            h.set('content-type', 'text/javascript'),
        }
      },
    },
  }
}

type Worker = {
  default: {
    fetch(
      req: Request,
      env: import('../src/edge-handler.mjs').AssetEnvironment,
    ): Promise<Response>
  }
}

async function loadWorker(source: string): Promise<Worker> {
  const file = join(tempRoot(), 'worker.mjs')
  writeFileSync(file, source)

  return import(pathToFileURL(file).href)
}

const fileNamed = (
  files: ReadonlyArray<{ fileName: string; source: string }> = [],
  fileName: string,
) => {
  const file = files.find(candidate => candidate.fileName === fileName)

  if (!file) {
    throw new Error(`adapter did not describe ${fileName}`)
  }

  return file.source
}

describe('cloudflarePages()', () => {
  it('describes _worker.js and a _routes.json limited to the assets prefix', async () => {
    const { clientFiles, privateFiles, warnings } =
      cloudflarePages().files(clientBuild())

    expect(privateFiles).toBeUndefined()
    expect(warnings).toEqual([])
    expect(JSON.parse(fileNamed(clientFiles, '_routes.json'))).toEqual({
      version: 1,
      include: ['/assets/*'],
      exclude: [],
    })

    const worker = await loadWorker(fileNamed(clientFiles, '_worker.js'))

    const env = fakeEnv(
      { '/assets/new-abc.js': 'new' },
      { 'assets/old-123.js': 'old' },
    )

    const get = (p: string) =>
      worker.default.fetch(new Request(`https://app.test${p}`), env)

    expect(await (await get('/assets/new-abc.js')).text()).toBe('new')
    const old = await get('/assets/old-123.js')
    expect(await old.text()).toBe('old')
    expect(old.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect((await get('/assets/never.js')).status).toBe(404)
    expect((await get('/jobs/42')).headers.get('content-type')).toBe(
      'text/html',
    )
  })

  it('warns that Pages ignores functions/ once a _worker.js exists', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'functions'))

    expect(cloudflarePages().files(clientBuild('/', root)).warnings).toEqual([
      expect.stringContaining('functions/'),
    ])
  })

  it('respects base: routes and R2 keys', async () => {
    const { clientFiles } = cloudflarePages().files(clientBuild('/app/'))

    expect(JSON.parse(fileNamed(clientFiles, '_routes.json')).include).toEqual([
      '/app/assets/*',
    ])

    const worker = await loadWorker(fileNamed(clientFiles, '_worker.js'))

    const res = await worker.default.fetch(
      new Request('https://app.test/app/assets/old-123.js'),
      fakeEnv({}, { 'assets/old-123.js': 'old' }),
    )

    expect(await res.text()).toBe('old')
  })
})

describe('cloudflareWorkers()', () => {
  it('describes one private worker file and nothing for the client output', async () => {
    const { clientFiles, privateFiles } = cloudflareWorkers({
      r2Binding: 'CHUNKS',
    }).files(clientBuild())

    expect(clientFiles).toBeUndefined()
    expect(privateFiles?.map(file => file.fileName)).toEqual([
      'dist-worker/index.js',
    ])

    const worker = await loadWorker(
      fileNamed(privateFiles, 'dist-worker/index.js'),
    )

    const env = {
      ...fakeEnv({}, {}),
      CHUNKS: {
        get: async () => ({
          body: 'old',
          httpEtag: '"e"',
          writeHttpMetadata() {},
        }),
      },
    }

    const res = await worker.default.fetch(
      new Request('https://app.test/assets/x.js'),
      env,
    )

    expect(await res.text()).toBe('old')
  })

  it('accepts an .mjs workerFile', () => {
    const { privateFiles } = cloudflareWorkers({
      workerFile: 'edge/worker.mjs',
    }).files(clientBuild())

    expect(privateFiles?.map(file => file.fileName)).toEqual([
      'edge/worker.mjs',
    ])
  })
})

describe('through the Vite plugin', () => {
  it('a Pages build has the worker and routes in the client output', async () => {
    const root = await buildFixture(cloudflarePages())

    expect(existsSync(join(root, 'dist/_worker.js'))).toBe(true)
    expect(
      JSON.parse(readFileSync(join(root, 'dist/_routes.json'), 'utf8')).include,
    ).toEqual(['/assets/*'])
  })

  it('a Workers build has the worker outside outDir and nothing extra in dist', async () => {
    const root = await buildFixture(cloudflareWorkers())

    expect(existsSync(join(root, 'dist-worker/index.js'))).toBe(true)
    expect(existsSync(join(root, 'dist/_worker.js'))).toBe(false)
  })

  it('refuses a workerFile inside outDir', async () => {
    await expect(
      buildFixture(cloudflareWorkers({ workerFile: 'dist/worker.js' })),
    ).rejects.toThrow(/outside outDir/)
  })
})

describe('edge handler', () => {
  it("edge handler without its R2 binding returns 404, not the SPA's HTML", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { serveAsset } = await import('../src/edge-handler.mjs')

    const env = {
      ASSETS: {
        fetch: async () =>
          new Response('<!doctype html>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
    }

    const res = await serveAsset(
      new Request('https://app.test/assets/x.js'),
      env,
      {
        base: '/',
        binding: 'BUILD_CACHE',
      },
    )

    expect(res.status).toBe(404)
  })

  const options = { base: '/', binding: 'BUILD_CACHE' }

  it('passes non-GET requests straight through', async () => {
    const { serveAsset } = await import('../src/edge-handler.mjs')
    const env = { ASSETS: { fetch: async () => assetsHtml() } }

    const res = await serveAsset(
      new Request('https://app.test/assets/x.js', { method: 'POST' }),
      env,
      options,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('keeps the original 404 when the binding is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { serveAsset } = await import('../src/edge-handler.mjs')

    const env = {
      ASSETS: { fetch: async () => new Response('gone', { status: 404 }) },
    }

    const res = await serveAsset(
      new Request('https://app.test/assets/x.js'),
      env,
      options,
    )

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('gone')
  })

  it('answers HEAD from R2 metadata without opening the body', async () => {
    const { serveAsset } = await import('../src/edge-handler.mjs')
    const get = vi.fn<() => void>()

    const env = {
      ASSETS: { fetch: async () => assetsHtml() },
      BUILD_CACHE: {
        get,
        head: async (key: string) =>
          key === 'assets/old-123.js'
            ? { httpEtag: '"e"', writeHttpMetadata() {} }
            : null,
      },
    }

    const res = await serveAsset(
      new Request('https://app.test/assets/old-123.js', { method: 'HEAD' }),
      env,
      options,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"e"')
    expect(await res.text()).toBe('')
    expect(get).not.toHaveBeenCalled()
  })
  it('serves an asset without a content type as the current build', async () => {
    const { serveAsset } = await import('../src/edge-handler.mjs')

    const env = {
      ASSETS: { fetch: async () => new Response('current', { status: 200 }) },
      BUILD_CACHE: { get: vi.fn<() => void>() },
    }

    const res = await serveAsset(
      new Request('https://app.test/assets/x.js'),
      env,
      options,
    )

    expect(await res.text()).toBe('current')
    expect(env.BUILD_CACHE.get).not.toHaveBeenCalled()
  })

  it('falls back to R2 on a bodiless 404, and 404s when R2 has no copy either', async () => {
    const { serveAsset } = await import('../src/edge-handler.mjs')

    const env = {
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
      BUILD_CACHE: {
        get: async (key: string) =>
          key === 'assets/old-123.js'
            ? { body: 'old', httpEtag: '"e"', writeHttpMetadata() {} }
            : null,
      },
    }

    const hit = await serveAsset(
      new Request('https://app.test/assets/old-123.js'),
      env,
      options,
    )

    expect(await hit.text()).toBe('old')

    const miss = await serveAsset(
      new Request('https://app.test/assets/never.js'),
      env,
      options,
    )

    expect(miss.status).toBe(404)
  })
})
