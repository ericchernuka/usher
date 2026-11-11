export function serveAsset(
  request: Request,
  env: { ASSETS: { fetch(request: Request): Promise<Response> } } & Record<
    string,
    unknown
  >,
  options: { base: string; binding: string },
): Promise<Response>
