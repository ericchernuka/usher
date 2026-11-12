import type { IncomingMessage, ServerResponse } from 'node:http'
import * as valibot from 'valibot'
import type { Connect } from 'vite'
import type { BuildFacts } from '@rndsqr/usher-core'
import {
  createDeploySimulation,
  DEPLOY_MODES,
  type DeploySimulation,
} from './simulated-deploy'

/** Path of the simulated-deploy endpoint, relative to `base`. */
export const DEPLOY_PATH = '__usher/deploy'

const isCdnBase = (base: string) => /^https?:/.test(base)

export const isRelativeBase = (base: string) =>
  !base.startsWith('/') && !isCdnBase(base)

/** The URL path of Vite's `base`. A CDN base keeps only its path. */
export const pathBase = (base: string) =>
  isCdnBase(base) ? new URL(base).pathname : base

/** Whether `url` requests `path` under `base`, ignoring the query. */
function isRequestFor(base: string, path: string, url: string | undefined) {
  const requested = url?.split('?')[0] ?? ''

  return isRelativeBase(base)
    ? requested.endsWith(`/${path}`)
    : requested === `${pathBase(base)}${path}`
}

/** Serves the version file in development, where nothing is written to disk. */
export function versionMiddleware(
  base: string,
  fileName: string,
  served: () => BuildFacts,
): (
  req: { url?: string | undefined },
  res: {
    setHeader(name: string, value: string): void
    end(body: string): void
  },
  next: () => void,
) => void {
  return (req, res, next) => {
    if (!isRequestFor(base, fileName, req.url)) {
      return next()
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(served()))
  }
}

const DeployRequest = valibot.pipe(
  valibot.string(),
  valibot.parseJson(),
  valibot.object({ mode: valibot.picklist(DEPLOY_MODES) }),
)

async function readBody(req: IncomingMessage) {
  let body = ''

  for await (const chunk of req) {
    body += String(chunk)
  }

  return body
}

function reply(
  res: ServerResponse,
  status: number,
  body: { type: string; text: string },
) {
  res.statusCode = status
  res.setHeader('Content-Type', body.type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body.text)
}

async function deploy(
  req: IncomingMessage,
  res: ServerResponse,
  simulation: DeploySimulation,
) {
  const request = valibot.safeParse(DeployRequest, await readBody(req))

  if (!request.success) {
    return reply(res, 400, {
      type: 'text/plain',
      text: `[usher] send JSON {"mode": ...} with one of: ${DEPLOY_MODES.join(', ')}.`,
    })
  }

  return reply(res, 200, {
    type: 'application/json',
    text: JSON.stringify(simulation.deploy(request.output.mode)),
  })
}

/**
 * Takes `POST <base>__usher/deploy` with `{ "mode": ... }`, changes what the
 * version middleware serves, and answers with the build facts now served.
 */
function deployMiddleware(
  base: string,
  simulation: DeploySimulation,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!isRequestFor(base, DEPLOY_PATH, req.url)) {
      return next()
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')

      return reply(res, 405, { type: 'text/plain', text: 'Use POST.' })
    }

    // Reading the body fails only when the client went away; close the connection.
    deploy(req, res, simulation).catch(() => res.destroy())
  }
}

export interface DevServing {
  base: string
  fileName: string
  /** The real build facts, served until a simulated deploy replaces them. */
  facts: BuildFacts
  devtools: boolean
}

/** Serves the version file, and with devtools the simulated-deploy endpoint. */
export function serveDevelopment(
  middlewares: Connect.Server,
  serving: DevServing,
) {
  const simulation = createDeploySimulation(serving.facts)

  middlewares.use(
    versionMiddleware(serving.base, serving.fileName, simulation.served),
  )

  if (serving.devtools) {
    middlewares.use(deployMiddleware(serving.base, simulation))
  }
}
