import type { IncomingMessage, ServerResponse } from 'node:http'
import { text } from 'node:stream/consumers'
import * as valibot from 'valibot'
import type { Connect } from 'vite'
import type { BuildFacts } from '@rndsqr/usher-core'
import {
  createDeploySimulation,
  DEPLOY_MODES,
  type DeploySimulation,
} from './simulated-deploy'

export const DEPLOY_PATH = '__usher/deploy'

const isRequestFor = (path: string, req: IncomingMessage) =>
  req.url?.split('?')[0] === path

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

function versionMiddleware(
  path: string,
  served: () => BuildFacts,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!isRequestFor(path, req)) {
      return next()
    }

    reply(res, 200, {
      type: 'application/json',
      text: JSON.stringify(served()),
    })
  }
}

const DeployRequest = valibot.pipe(
  valibot.string(),
  valibot.parseJson(),
  valibot.object({ mode: valibot.picklist(DEPLOY_MODES) }),
)

async function deploy(
  req: IncomingMessage,
  res: ServerResponse,
  simulation: DeploySimulation,
) {
  const request = valibot.safeParse(DeployRequest, await text(req))

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

function deployMiddleware(
  path: string,
  simulation: DeploySimulation,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!isRequestFor(path, req)) {
      return next()
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')

      return reply(res, 405, { type: 'text/plain', text: 'Use POST.' })
    }

    // A browser sends JSON to another origin only after a preflight, which this
    // server does not answer. So no page on another site can trigger a deploy.
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return reply(res, 415, {
        type: 'text/plain',
        text: '[usher] send the deploy as Content-Type: application/json.',
      })
    }

    deploy(req, res, simulation).catch(() => res.destroy())
  }
}

export interface DevServing {
  /**
   * The dev server's base. Vite resolves it to an absolute path there, whatever
   * was configured: a relative base becomes "/" and a CDN base keeps its path.
   */
  base: string
  fileName: string
  facts: BuildFacts
  devtools: boolean
}

export function serveDevelopment(
  middlewares: Connect.Server,
  serving: DevServing,
) {
  const simulation = createDeploySimulation(serving.facts)

  middlewares.use(
    versionMiddleware(serving.base + serving.fileName, simulation.served),
  )

  if (serving.devtools) {
    middlewares.use(deployMiddleware(serving.base + DEPLOY_PATH, simulation))
  }
}
