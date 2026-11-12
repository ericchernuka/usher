import { SELF } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('answers its own API route without the asset fallback', async () => {
  const res = await SELF.fetch('https://app.test/api/health')

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ api: true })
})
