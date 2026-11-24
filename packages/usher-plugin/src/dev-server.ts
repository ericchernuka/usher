import type { IncomingMessage, ServerResponse } from 'node:http'
import { text } from 'node:stream/consumers'
import * as valibot from 'valibot'
import type { Connect } from 'vite'
import type { BuildFacts } from '@ericchernuka/usher-core'
import {
  createDeploySimulation,
  DEPLOY_MODES,
  type DeploySimulation,
} from './simulated-deploy'

/** Where the page posts a simulated deploy. `base` is the dev server's base. */
export const deployUrl = (base: string) => `${base}__usher/deploy`

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

/** Answers requests for `path`, whatever their query, and passes the rest on. */
function route(
  path: string,
  answer: (req: IncomingMessage, res: ServerResponse) => void,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url?.split('?')[0] === path) {
      answer(req, res)
    } else {
      next()
    }
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

function answerDeploy(simulation: DeploySimulation) {
  return (req: IncomingMessage, res: ServerResponse) => {
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
  /** The build layout's version URL, which is a path on the dev server. */
  versionUrl: string
  facts: BuildFacts
  devtools: boolean
}

export function serveDevelopment(
  middlewares: Connect.Server,
  serving: DevServing,
) {
  const simulation = createDeploySimulation(serving.facts)

  middlewares.use(
    route(serving.versionUrl, (_req, res) =>
      reply(res, 200, {
        type: 'application/json',
        text: JSON.stringify(simulation.served()),
      }),
    ),
  )

  if (serving.devtools) {
    middlewares.use(route(deployUrl(serving.base), answerDeploy(simulation)))
  }
}
