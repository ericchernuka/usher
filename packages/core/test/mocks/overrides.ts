// Per-test overrides for `server.use(...)`. Each builds a handler; none keeps state.
import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { VersionInfo } from '../../src/types'
import { versionHandler, VERSION_URL, type Serve } from './handlers'

/** The server now has this build. */
export const serveBuild = (build: VersionInfo, options?: Serve): HttpHandler =>
  versionHandler(build, options)

/** The server answers 200 with something that isn't a build. */
export const serveRaw = (body: object, options?: Serve): HttpHandler =>
  versionHandler(body, options)

/** The server errors, e.g. a deploy in progress. */
export const serveError = (
  status: number,
  options?: Omit<Serve, 'status'>,
): HttpHandler =>
  versionHandler({ error: 'unavailable' }, { ...options, status })

/** The request fails at the network level. */
export const serveNetworkError = (
  options: { once?: boolean } = {},
): HttpHandler => http.get(VERSION_URL, () => HttpResponse.error(), options)

/** The request never gets an answer (until the client gives up). `once`: only the next request hangs. */
export const serveHang = (options: { once?: boolean } = {}): HttpHandler =>
  http.get(VERSION_URL, () => new Promise<never>(() => {}), options)
