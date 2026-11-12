// The default network: every test starts here, and overrides with `server.use(...)`.
import { http, HttpResponse, type HttpHandler } from 'msw/http'
import { appVersion } from '../build-info.stub'

export const VERSION_URL = 'https://app.test/version.json'

export interface Serve {
  status?: number
  /** The `Date` header: a fixed time, none (`null`), or by default the time of the request. */
  date?: Date | null
  /** How far this server's clock runs ahead of the page's (a skewed server), in ms. */
  skewMs?: number
  /** Answer one request, then fall back to the handler underneath. */
  once?: boolean
}

/** `/version.json` as a CDN serves it: JSON, uncacheable, stamped with the server's date. */
export function versionHandler(
  body: import('msw').JsonBodyType,
  { status = 200, date, skewMs = 0, once = false }: Serve = {},
): HttpHandler {
  return http.get(
    VERSION_URL, // the `?t=` cache-buster doesn't take part in matching
    () =>
      HttpResponse.json(body, {
        status,
        headers: {
          'Cache-Control': 'no-store',
          ...(date !== null && {
            Date: (date ?? new Date(Date.now() + skewMs)).toUTCString(),
          }),
        },
      }),
    { once },
  )
}

/** The happy path: the deployed build is the one this tab runs, so it is up to date. */
export const handlers = [versionHandler(appVersion)]
