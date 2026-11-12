import { createAssetFallback, type AssetFallbackEnv } from '../../src/worker.ts'

const assets = createAssetFallback()

/** An app-owned worker: it answers its own routes and hands the rest to the asset fallback. */
export default {
  fetch(request: Request, env: AssetFallbackEnv) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return Response.json({ api: true })
    }

    return assets(request, env)
  },
}
