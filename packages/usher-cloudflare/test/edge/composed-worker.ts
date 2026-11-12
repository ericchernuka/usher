import { createAssetFallback, type AssetFallbackEnv } from '../../src/worker.ts'

const assets = createAssetFallback()

export default {
  fetch(request: Request, env: AssetFallbackEnv) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return Response.json({ api: true })
    }

    return assets(request, env)
  },
}
