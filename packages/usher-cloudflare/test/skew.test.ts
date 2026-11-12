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
  usher,
  type ClientBuild,
  type SkewProtectionAdapter,
} from '@rndsqr/usher-plugin/vite'
import { cloudflarePages, cloudflareWorkers } from '../src/index'
import { createAssetFallback, type ChunkArchive } from '../src/worker'

const assetsHtml = () =>
  new Response('<!doctype html>', {
    headers: { 'content-type': 'text/html' },
  })

/** An R2 bucket with only the methods a test cares about. */
const archiveOf = (bucket: Partial<ChunkArchive>): ChunkArchive => ({
  get: async () => null,
  head: async () => null,
  ...bucket,
})

const tempRoot = () => mkdtempSync(join(tmpdir(), 'usher-skew-'))

const clientBuild = (base = '/', root = tempRoot()): ClientBuild => ({
  base,
  assetsPrefix: `${base}assets/`,
  root,
})

async function buildFixture(adapter: SkewProtectionAdapter) {
  const root = tempRoot()
  writeFileSync(
    join(root, 'index.html'),
    `<script type="module" src="/main.js"></script>`,
  )
  writeFileSync(join(root, 'main.js'), `console.log("hi")`)
  await build({
    root,
    logLevel: 'silent',
    plugins: [usher({ version: 'sha', adapter })],
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
    CHUNK_ARCHIVE: archiveOf({
      async get(key: string) {
        if (!(key in r2)) {
          return null
        }

        return {
          body: r2[key] ?? null,
          httpEtag: '"etag"',
          writeHttpMetadata: (h: Headers) =>
            h.set('content-type', 'text/javascript'),
        }
      },
    }),
  }
}

type Worker = {
  default: { fetch: ReturnType<typeof createAssetFallback<'CHUNKS'>> }
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

describe('a generated worker', () => {
  it('has exactly one export, the default', () => {
    const { clientFiles } = cloudflarePages().files(clientBuild())
    const source = fileNamed(clientFiles, '_worker.js')

    expect(source.match(/^export\b/gm)).toEqual(['export'])
    expect(source).toContain('export default {')
    expect(source).not.toMatch(/^import\b/m)
  })

  it('carries the base, assets directory and binding from the build', () => {
    const { privateFiles } = cloudflareWorkers({ r2Binding: 'CHUNKS' }).files({
      base: '/app/',
      assetsPrefix: '/app/static/chunks/',
      root: tempRoot(),
    })

    expect(fileNamed(privateFiles, 'dist-worker/index.js')).toContain(
      '{"base":"/app/","assetsDir":"static/chunks","r2Binding":"CHUNKS"}',
    )
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
      CHUNKS: archiveOf({
        get: async () => ({
          body: 'old',
          httpEtag: '"e"',
          writeHttpMetadata() {},
        }),
      }),
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

describe('createAssetFallback()', () => {
  const fallback = createAssetFallback()

  it("without its R2 binding returns 404, not the SPA's HTML", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const env = {
      ASSETS: {
        fetch: async () =>
          new Response('<!doctype html>', {
            headers: { 'content-type': 'text/html' },
          }),
      },
    }

    const res = await fallback(new Request('https://app.test/assets/x.js'), env)

    expect(res.status).toBe(404)
  })

  it('passes non-GET requests straight through', async () => {
    const env = { ASSETS: { fetch: async () => assetsHtml() } }

    const res = await fallback(
      new Request('https://app.test/assets/x.js', { method: 'POST' }),
      env,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('keeps the original 404 when the binding is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const env = {
      ASSETS: { fetch: async () => new Response('gone', { status: 404 }) },
    }

    const res = await fallback(new Request('https://app.test/assets/x.js'), env)

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('gone')
  })

  it('answers HEAD from R2 metadata without opening the body', async () => {
    const get = vi.fn<ChunkArchive['get']>(async () => null)

    const env = {
      ASSETS: { fetch: async () => assetsHtml() },
      CHUNK_ARCHIVE: archiveOf({
        get,
        head: async (key: string) =>
          key === 'assets/old-123.js'
            ? { httpEtag: '"e"', writeHttpMetadata() {} }
            : null,
      }),
    }

    const res = await fallback(
      new Request('https://app.test/assets/old-123.js', { method: 'HEAD' }),
      env,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBe('"e"')
    expect(await res.text()).toBe('')
    expect(get).not.toHaveBeenCalled()
  })
  it('serves an asset without a content type as the current build', async () => {
    const get = vi.fn<ChunkArchive['get']>(async () => null)

    const env = {
      ASSETS: { fetch: async () => new Response('current', { status: 200 }) },
      CHUNK_ARCHIVE: archiveOf({ get }),
    }

    const res = await fallback(new Request('https://app.test/assets/x.js'), env)

    expect(await res.text()).toBe('current')
    expect(get).not.toHaveBeenCalled()
  })

  it('falls back to R2 on a bodiless 404, and 404s when R2 has no copy either', async () => {
    const env = {
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
      CHUNK_ARCHIVE: archiveOf({
        get: async (key: string) =>
          key === 'assets/old-123.js'
            ? { body: 'old', httpEtag: '"e"', writeHttpMetadata() {} }
            : null,
      }),
    }

    const hit = await fallback(
      new Request('https://app.test/assets/old-123.js'),
      env,
    )

    expect(await hit.text()).toBe('old')

    const miss = await fallback(
      new Request('https://app.test/assets/never.js'),
      env,
    )

    expect(miss.status).toBe(404)
  })

  it('leaves a request outside the assets prefix to static assets, without asking R2', async () => {
    const get = vi.fn<ChunkArchive['get']>(async () => null)

    const env = {
      ASSETS: { fetch: async () => assetsHtml() },
      CHUNK_ARCHIVE: archiveOf({ get }),
    }

    const res = await fallback(new Request('https://app.test/jobs/42'), env)

    expect(res.headers.get('content-type')).toBe('text/html')
    expect(get).not.toHaveBeenCalled()
  })

  it('uses a custom base and assets directory for the prefix and the R2 key', async () => {
    const keys: string[] = []

    const env = {
      ASSETS: { fetch: async () => assetsHtml() },
      CHUNK_ARCHIVE: archiveOf({
        get: async (key: string) => {
          keys.push(key)

          return { body: 'old', httpEtag: '"e"', writeHttpMetadata() {} }
        },
      }),
    }

    const scoped = createAssetFallback({ base: '/app/', assetsDir: 'chunks' })

    const hit = await scoped(
      new Request('https://app.test/app/chunks/old-123.js'),
      env,
    )

    const outside = await scoped(
      new Request('https://app.test/app/assets/old-123.js'),
      env,
    )

    expect(await hit.text()).toBe('old')
    expect(outside.headers.get('content-type')).toBe('text/html')
    expect(keys).toEqual(['chunks/old-123.js'])
  })
})
