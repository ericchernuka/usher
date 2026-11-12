function isMissing(response) {
  return (
    response.status === 404 ||
    (response.headers.get('content-type') ?? '').includes('text/html')
  )
}

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

  const release = () => current.body?.cancel()

  const bucket = env[binding]

  if (!bucket) {
    console.warn(
      `[app-version] R2 binding "${binding}" is missing; skew protection is off`,
    )

    if (current.status === 404) {
      return current
    }

    await release()

    return new Response('Not found', { status: 404 })
  }

  const key = new URL(request.url).pathname.slice(base.length)

  const old =
    request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key)

  await release()

  if (!old) {
    return new Response('Not found', { status: 404 })
  }

  return assetResponse(old)
}
