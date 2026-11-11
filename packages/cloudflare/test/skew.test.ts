import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, createLogger, type Logger } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { appVersion, type SkewProtectionAdapter } from '@app-version/core/vite'
import { cloudflarePages, cloudflareWorkers } from '../src/index'

async function buildFixture(
  skewProtection: SkewProtectionAdapter,
  base = '/',
  customLogger?: Logger,
) {
  const root = mkdtempSync(join(tmpdir(), 'app-version-skew-'))
  if (customLogger) mkdirSync(join(root, 'functions'))
  writeFileSync(
    join(root, 'index.html'),
    `<script type="module" src="/main.js"></script>`,
  )
  writeFileSync(join(root, 'main.js'), `console.log("hi")`)
  await build({
    root,
    base,
    logLevel: 'silent',
    ...(customLogger && { customLogger }),
    plugins: [appVersion({ version: 'sha', skewProtection })],
  })
  return root
}

/** Fake Cloudflare env: ASSETS answers like Pages SPA mode, R2 holds one old chunk. */
function fakeEnv(files: Record<string, string>, r2: Record<string, string>) {
  return {
    ASSETS: {
      async fetch(req: Request) {
        const path = new URL(req.url).pathname
        if (files[path])
          return new Response(files[path], {
            headers: { 'content-type': 'text/javascript' },
          })
        return new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html' },
        }) // SPA fallback, 200
      },
    },
    BUILD_CACHE: {
      async get(key: string) {
        if (!(key in r2)) return null
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
  default: { fetch(req: Request, env: unknown): Promise<Response> }
}

describe('skewProtection: pages', () => {
  it('emits _worker.js and _routes.json limited to the assets prefix', async () => {
    const root = await buildFixture(cloudflarePages())
    const routes = JSON.parse(
      readFileSync(join(root, 'dist/_routes.json'), 'utf8'),
    )
    expect(routes).toEqual({ version: 1, include: ['/assets/*'], exclude: [] })

    const worker: Worker = await import(
      pathToFileURL(join(root, 'dist/_worker.js')).href
    )
    const env = fakeEnv(
      { '/assets/new-abc.js': 'new' },
      { 'assets/old-123.js': 'old' },
    )
    const get = (p: string) =>
      worker.default.fetch(new Request(`https://app.test${p}`), env)

    expect(await (await get('/assets/new-abc.js')).text()).toBe('new') // current deploy
    const old = await get('/assets/old-123.js') // gone from deploy, in R2
    expect(await old.text()).toBe('old')
    expect(old.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect((await get('/assets/never.js')).status).toBe(404) // not a SPA-fallback 200
    expect((await get('/jobs/42')).headers.get('content-type')).toBe(
      'text/html',
    ) // non-asset passes through
  })

  it('warns that Pages ignores functions/ once a _worker.js exists', async () => {
    const logger = createLogger('silent')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await buildFixture(cloudflarePages(), '/', logger)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('functions/'))
  })

  it('respects base: routes and R2 keys', async () => {
    const root = await buildFixture(cloudflarePages(), '/app/')
    const routes = JSON.parse(
      readFileSync(join(root, 'dist/_routes.json'), 'utf8'),
    )
    expect(routes.include).toEqual(['/app/assets/*'])
    const worker: Worker = await import(
      pathToFileURL(join(root, 'dist/_worker.js')).href
    )
    const res = await worker.default.fetch(
      new Request('https://app.test/app/assets/old-123.js'),
      fakeEnv({}, { 'assets/old-123.js': 'old' }),
    )
    expect(await res.text()).toBe('old')
  })
})

describe('skewProtection: workers', () => {
  it('writes the worker outside outDir and nothing extra into dist', async () => {
    const root = await buildFixture(cloudflareWorkers({ r2Binding: 'CHUNKS' }))
    expect(existsSync(join(root, 'dist/_worker.js'))).toBe(false)
    const file = join(root, 'dist-worker/index.js')
    const source = readFileSync(file, 'utf8')
    expect(source).toContain('"binding":"CHUNKS"')

    const worker: Worker = await import(pathToFileURL(file).href)
    const env = fakeEnv({}, {})
    const res = await worker.default.fetch(
      new Request('https://app.test/assets/x.js'),
      {
        ...env,
        CHUNKS: {
          get: async () => ({
            body: 'old',
            httpEtag: '"e"',
            writeHttpMetadata() {},
          }),
        },
      },
    )
    expect(await res.text()).toBe('old')
  })

  it('accepts an .mjs workerFile', async () => {
    const root = await buildFixture(
      cloudflareWorkers({ workerFile: 'edge/worker.mjs' }),
    )
    const worker: Worker = await import(
      pathToFileURL(join(root, 'edge/worker.mjs')).href
    )
    const res = await worker.default.fetch(
      new Request('https://app.test/assets/old-123.js'),
      fakeEnv({}, { 'assets/old-123.js': 'old' }),
    )
    expect(await res.text()).toBe('old')
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
  const assetsHtml = () =>
    new Response('<!doctype html>', {
      headers: { 'content-type': 'text/html' },
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
    const get = vi.fn()
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
      BUILD_CACHE: { get: vi.fn() },
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
