import { createAssetFallback, type AssetFallbackEnv } from '../../src/worker.ts'

const assets = createAssetFallback()

export default {
  fetch: (request: Request, env: AssetFallbackEnv) => assets(request, env),
}
