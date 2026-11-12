import type { BuildFacts } from '@app-version/core'

const isCdnBase = (base: string) => /^https?:/.test(base)

export const isRelativeBase = (base: string) =>
  !base.startsWith('/') && !isCdnBase(base)

/** The URL path of Vite's `base`. A CDN base keeps only its path. */
export const pathBase = (base: string) =>
  isCdnBase(base) ? new URL(base).pathname : base

function isVersionRequest(
  base: string,
  fileName: string,
  url: string | undefined,
) {
  const path = url?.split('?')[0] ?? ''

  return isRelativeBase(base)
    ? path.endsWith(`/${fileName}`)
    : path === `${pathBase(base)}${fileName}`
}

/** Serves the version file in development, where nothing is written to disk. */
export function versionMiddleware(
  base: string,
  fileName: string,
  facts: BuildFacts,
): (
  req: { url?: string | undefined },
  res: {
    setHeader(name: string, value: string): void
    end(body: string): void
  },
  next: () => void,
) => void {
  return (req, res, next) => {
    if (!isVersionRequest(base, fileName, req.url)) {
      return next()
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(facts))
  }
}
