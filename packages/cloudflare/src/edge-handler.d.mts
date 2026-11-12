export interface AssetEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export function serveAsset(
  request: Request,
  env: AssetEnvironment,
  options: { base: string; binding: string },
): Promise<Response>
