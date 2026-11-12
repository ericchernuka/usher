// Skew-protection handler for Cloudflare. Plain JS with no imports: the Vite plugin
// copies this file verbatim into the emitted worker, so keep it self-contained.

/**
 * Serve a hashed asset from the current deploy; if it's gone, serve the copy
 * an older build left in R2.
 *
 * @param {Request} request
 * @param {{ ASSETS: { fetch(r: Request): Promise<Response> } } & Record<string, any>} env
 * @param {{ base: string, binding: string }} options
 * @returns {Promise<Response>}
 */
/** Pages and Workers SPA mode answer a missing file with index.html and a 200. */
function isMissing(response) {
  return (
    response.status === 404 ||
    (response.headers.get('content-type') ?? '').includes('text/html')
  )
}

/** An R2 object as an immutable asset response. */
function assetResponse(old) {
  const headers = new Headers()
  old.writeHttpMetadata(headers)
  headers.set('ETag', old.httpEtag)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

  return new Response('body' in old ? old.body : null, { headers })
}

export async function serveAsset(request, env, { base, binding }) {
  const current = await env.ASSETS.fetch(request)

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return current
  }

  if (!isMissing(current)) {
    return current
  }

  // Falling back: release the unused response so the runtime doesn't leak its stream.
  const release = () => current.body?.cancel()

  const bucket = env[binding]

  if (!bucket) {
    console.warn(
      `[app-version] R2 binding "${binding}" is missing; skew protection is off`,
    )

    if (current.status === 404) {
      return current
    }

    await release() // never answer a JS/CSS request with the SPA's HTML

    return new Response('Not found', { status: 404 })
  }

  // CI syncs dist/assets to <bucket>/assets, so keys are paths relative to `base`.
  const key = new URL(request.url).pathname.slice(base.length)

  // HEAD needs only metadata; get() would open a body nobody reads.
  const old =
    request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key)

  await release()

  if (!old) {
    return new Response('Not found', { status: 404 })
  }

  return assetResponse(old)
}
