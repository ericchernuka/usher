export interface AssetFallbackOptions<
  Binding extends string = 'CHUNK_ARCHIVE',
> {
  /** URL path of Vite's `base`. Default "/". */
  base?: string
  /** Vite's `build.assetsDir`. Default "assets". */
  assetsDir?: string
  /** Name of the R2 binding that holds the chunk archive. Default "CHUNK_ARCHIVE". */
  r2Binding?: Binding
}

/** The parts of an R2 object the handler uses. */
export interface ArchivedChunk {
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
  body?: BodyInit | null
}

/** The parts of an R2 bucket the handler uses. An `R2Bucket` satisfies it. */
export interface ChunkArchive {
  get(key: string): Promise<ArchivedChunk | null>
  head(key: string): Promise<ArchivedChunk | null>
}

/**
 * The bindings the handler reads. A Worker's own `Env` satisfies it when it has
 * both, so a missing or misnamed R2 binding is a type error in the Worker.
 */
export type AssetFallbackEnv<Binding extends string = 'CHUNK_ARCHIVE'> = {
  /** The current deployment's static assets. */
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
} & {
  /** The chunk archive, an R2 bucket bound under the name given as `r2Binding`. */
  readonly [Name in Binding]: ChunkArchive
}

/** The handler: call it from a Worker's `fetch` with the request and the Worker's `env`. */
export type AssetFallback<Binding extends string> = (
  request: Request,
  env: AssetFallbackEnv<Binding>,
) => Promise<Response>

/**
 * Create the asset fallback handler: it serves a request from the current
 * deployment, and when that deployment no longer has a chunk, from the chunk
 * archive in R2.
 *
 * Requests outside `<base><assetsDir>/` and requests that are not GET or HEAD
 * get the current deployment's answer unchanged. A chunk in neither place is a
 * real 404, never the SPA's HTML fallback, and browsers must not store it.
 * Archive keys are paths relative to `base`, matching
 * `aws s3 sync dist/assets s3://<bucket>/assets`.
 */
export function createAssetFallback<Binding extends string = 'CHUNK_ARCHIVE'>(
  options?: AssetFallbackOptions<Binding>,
): AssetFallback<Binding>
export function createAssetFallback<Binding extends string>(
  options: AssetFallbackOptions<Binding> = {},
): AssetFallback<Binding | 'CHUNK_ARCHIVE'> {
  const base = options.base ?? '/'
  const prefix = `${base}${options.assetsDir ?? 'assets'}/`
  const binding = options.r2Binding ?? 'CHUNK_ARCHIVE'

  // Prevent browsers from replaying a chunk 404 after the chunk reaches the
  // archive, because chunk URLs are content-hashed and Cloudflare caches a 404
  // without Cache-Control for the zone's Browser Cache TTL
  //
  // Keep notFound inside createAssetFallback because the generated worker
  // inlines only createAssetFallback.toString() (ADR 0006)
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const notFound = () =>
    new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    })

  const isChunkRead = (request: Request) =>
    (request.method === 'GET' || request.method === 'HEAD') &&
    new URL(request.url).pathname.startsWith(prefix)

  const fromArchive = async (request: Request, archive: ChunkArchive) => {
    const key = new URL(request.url).pathname.slice(base.length)

    const chunk =
      request.method === 'HEAD'
        ? await archive.head(key)
        : await archive.get(key)

    if (!chunk) {
      return notFound()
    }

    const headers = new Headers()
    chunk.writeHttpMetadata(headers)
    headers.set('ETag', chunk.httpEtag)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')

    return new Response(chunk.body ?? null, { headers })
  }

  return async (request, env) => {
    const current = await env.ASSETS.fetch(request)

    // Pages answers a missing file with index.html and a 200, so HTML is a miss.
    const isMiss =
      current.status === 404 ||
      current.headers.get('content-type')?.includes('text/html')

    if (!isChunkRead(request) || !isMiss) {
      return current
    }

    // The type requires the binding, but a deployed Worker can still lack it.
    const archive: ChunkArchive | undefined = env[binding]

    if (!archive) {
      console.warn(
        `[usher] R2 binding "${binding}" is missing, so skew protection is off. Add an R2 bucket binding named "${binding}" to this Worker or Pages project.`,
      )
    }

    const response = archive ? await fromArchive(request, archive) : notFound()

    await current.body?.cancel()

    return response
  }
}
