import type { BuildFacts } from '@rndsqr/usher-core'

export const DEPLOY_MODES = ['advance', 'force', 'rollback', 'reset'] as const

export type DeployMode = (typeof DEPLOY_MODES)[number]

export interface SimulatedDeploy {
  mode: Exclude<DeployMode, 'reset'>
  sequence: number
}

const ROLLBACK_DISTANCE = 1_000

export function simulatedBuild(
  real: BuildFacts,
  deploy: SimulatedDeploy,
  now: Date,
): BuildFacts {
  const buildTime = new Date(
    Math.max(now.getTime(), Date.parse(real.buildTime) + 1),
  ).toISOString()

  const facts: BuildFacts = {
    version: `${real.version}-dev-${deploy.sequence}`,
    commitTime: real.commitTime,
    buildTime,
  }

  if (deploy.mode === 'force') {
    facts.forceUpdateBuiltBefore = buildTime
  }

  if (deploy.mode === 'rollback') {
    facts.commitTime = new Date(
      Date.parse(real.commitTime) - ROLLBACK_DISTANCE,
    ).toISOString()
  }

  return facts
}

export interface DeploySimulation {
  served: () => BuildFacts
  deploy: (mode: DeployMode) => BuildFacts
}

export function createDeploySimulation(real: BuildFacts): DeploySimulation {
  let simulated: BuildFacts | undefined
  let sequence = 0
  const served = () => simulated ?? real

  return {
    served,
    deploy(mode) {
      if (mode === 'reset') {
        simulated = undefined
      } else {
        sequence += 1
        simulated = simulatedBuild(real, { mode, sequence }, new Date())
      }

      return served()
    },
  }
}
