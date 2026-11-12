import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { ClientBuild } from '@rndsqr/usher-plugin/adapter'
import { cloudflarePages, cloudflareWorkers } from '../src/index'
import {
  createAssetFallback,
  type AssetFallback,
  type AssetFallbackEnv,
  type ChunkArchive,
} from '../src/worker'

const assetsHtml = () =>
  new Response('<!doctype html>', {
    headers: { 'content-type': 'text/html' },
  })

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

type Worker = {
  default: { fetch: AssetFallback<'CHUNKS'> }
}

function withoutBinding(assets: AssetFallbackEnv['ASSETS']): AssetFallbackEnv {
  const env: AssetFallbackEnv = { ASSETS: assets, CHUNK_ARCHIVE: archiveOf({}) }
  Reflect.deleteProperty(env, 'CHUNK_ARCHIVE')

  return env
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
  it('describes _worker.js and a _routes.json limited to the assets prefix', () => {
    const { clientFiles, privateFiles, warnings } = cloudflarePages().files(
      clientBuild('/app/'),
    )

    expect(privateFiles).toBeUndefined()
    expect(warnings).toEqual([])
    expect(fileNamed(clientFiles, '_worker.js')).toContain('export default {')
    expect(JSON.parse(fileNamed(clientFiles, '_routes.json'))).toEqual({
      version: 1,
      include: ['/app/assets/*'],
      exclude: [],
    })
  })

  it('warns that Pages ignores functions/ once a _worker.js exists', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'functions'))

    expect(cloudflarePages().files(clientBuild('/', root)).warnings).toEqual([
      expect.stringContaining('functions/'),
    ])
  })
})

describe('cloudflareWorkers()', () => {
  it('describes one private worker file, at the configured path, and nothing for the client output', () => {
    const { clientFiles, privateFiles } =
      cloudflareWorkers().files(clientBuild())

    expect(clientFiles).toBeUndefined()
    expect(privateFiles?.map(file => file.fileName)).toEqual([
      'dist-worker/index.js',
    ])
    expect(
      cloudflareWorkers({ workerFile: 'edge/worker.mjs' })
        .files(clientBuild())
        .privateFiles?.map(file => file.fileName),
    ).toEqual(['edge/worker.mjs'])
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

  it('serves old chunks for the base, assets directory and R2 binding of the build', async () => {
    const { privateFiles } = cloudflareWorkers({ r2Binding: 'CHUNKS' }).files({
      base: '/app/',
      assetsPrefix: '/app/static/chunks/',
      root: tempRoot(),
    })

    const worker = await loadWorker(
      fileNamed(privateFiles, 'dist-worker/index.js'),
    )

    const keys: string[] = []

    const env = {
      ASSETS: { fetch: async () => assetsHtml() },
      CHUNKS: archiveOf({
        get: async (key: string) => {
          keys.push(key)

          return { body: 'old', httpEtag: '"e"', writeHttpMetadata() {} }
        },
      }),
    }

    const get = (path: string) =>
      worker.default.fetch(new Request(`https://app.test${path}`), env)

    expect(await (await get('/app/static/chunks/old-123.js')).text()).toBe(
      'old',
    )
    expect(
      (await get('/app/assets/old-123.js')).headers.get('content-type'),
    ).toBe('text/html')
    expect(keys).toEqual(['static/chunks/old-123.js'])
  })
})

describe('createAssetFallback()', () => {
  const fallback = createAssetFallback()

  it("without its R2 binding warns and returns 404, not the SPA's HTML", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const env = withoutBinding({ fetch: async () => assetsHtml() })

    const res = await fallback(new Request('https://app.test/assets/x.js'), env)

    expect(res.status).toBe(404)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /R2 binding "CHUNK_ARCHIVE" is missing.*Add an R2 bucket binding named "CHUNK_ARCHIVE"/,
      ),
    )
  })

  it('requires the R2 binding in the env type, under the name it was given', () => {
    expectTypeOf(createAssetFallback())
      .parameter(1)
      .toHaveProperty('CHUNK_ARCHIVE')
      .toEqualTypeOf<ChunkArchive>()

    expectTypeOf(createAssetFallback({ r2Binding: 'CHUNKS' }))
      .parameter(1)
      .toEqualTypeOf<AssetFallbackEnv<'CHUNKS'>>()
  })

  it('passes non-GET requests straight through', async () => {
    const env = {
      ASSETS: { fetch: async () => assetsHtml() },
      CHUNK_ARCHIVE: archiveOf({}),
    }

    const res = await fallback(
      new Request('https://app.test/assets/x.js', { method: 'POST' }),
      env,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })

  it('keeps the original 404 when the binding is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const env = withoutBinding({
      fetch: async () => new Response('gone', { status: 404 }),
    })

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
