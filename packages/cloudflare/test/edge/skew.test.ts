// Runs inside workerd. One file, executed against both the Pages and Workers builds.
import { env, SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

declare global {
  namespace Cloudflare {
    interface Env {
      BUILD_CACHE: R2Bucket
      CURRENT_ASSET: string
    }
  }
}

const get = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://app.test${path}`, init)

describe('emitted skew-protection worker', () => {
  beforeEach(async () => {
    await env.BUILD_CACHE.put('assets/old-123.js', "console.log('yesterday')", {
      httpMetadata: { contentType: 'text/javascript' },
    })
  })

  it("serves the current build's chunk from static assets", async () => {
    const res = await get(env.CURRENT_ASSET)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('current build')
  })

  it('serves a chunk the current build no longer has from R2', async () => {
    const res = await get('/assets/old-123.js')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("console.log('yesterday')")
    expect(res.headers.get('content-type')).toBe('text/javascript')
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(res.headers.get('etag')).toMatch(/^"/)
  })

  it('answers HEAD from R2 without a body', async () => {
    const res = await get('/assets/old-123.js', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it("returns a real 404, not the SPA's index.html, for an unknown chunk", async () => {
    const res = await get('/assets/never-shipped.js')
    expect(res.status).toBe(404)
  })

  it('leaves app routes to the SPA fallback', async () => {
    const res = await get('/jobs/42')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
