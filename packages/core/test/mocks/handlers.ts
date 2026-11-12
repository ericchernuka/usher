import { http, HttpResponse, type HttpHandler } from 'msw/http'
import { runningBuild } from '../build-info.stub'

export const VERSION_URL = 'https://app.test/version.json'

export interface Serve {
  status?: number
  date?: Date | null
  skewMs?: number
  once?: boolean
}

export function versionHandler(
  body: import('msw').JsonBodyType,
  { status = 200, date, skewMs = 0, once = false }: Serve = {},
): HttpHandler {
  return http.get(
    VERSION_URL,
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

export const handlers = [versionHandler(runningBuild)]
