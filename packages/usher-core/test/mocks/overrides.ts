import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { BuildFacts } from '../../src/build-facts'
import { versionHandler, VERSION_URL, type Serve } from './handlers'

export const serveBuild = (build: BuildFacts, options?: Serve): HttpHandler =>
  versionHandler(build, options)

export const serveRaw = (
  body: import('msw').JsonBodyType,
  options?: Serve,
): HttpHandler => versionHandler(body, options)

export const serveError = (
  status: number,
  options?: Omit<Serve, 'status'>,
): HttpHandler =>
  versionHandler({ error: 'unavailable' }, { ...options, status })

export const serveCutOff = (): HttpHandler =>
  http.get(
    VERSION_URL,
    () =>
      new HttpResponse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'))
            controller.error(new TypeError('terminated'))
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  )

export const serveNetworkError = (): HttpHandler =>
  http.get(VERSION_URL, () => HttpResponse.error())

export const serveHang = (options: { once?: boolean } = {}): HttpHandler =>
  http.get(VERSION_URL, () => new Promise<never>(() => {}), options)
