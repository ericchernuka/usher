import type { BuildFacts } from '@rndsqr/usher-core'

export const DEPLOY_MODES = ['advance', 'force', 'rollback', 'reset'] as const

export type DeployMode = (typeof DEPLOY_MODES)[number]

/** One simulated deploy: its mode and its position in the dev server's sequence. */
export interface SimulatedDeploy {
  mode: Exclude<DeployMode, 'reset'>
  sequence: number
}

/** How far before the real commit a simulated rollback's source lies. */
const ROLLBACK_DISTANCE = 1_000

/**
 * Build facts for a simulated deploy, derived from the real build every time so
 * that a forced-update cutoff from one deploy never carries into the next.
 * The build time is always later than the real one, even within the same
 * millisecond, so a forced-update cutoff at that time supersedes the real build.
 */
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
  /** The build facts the dev server serves now. */
  served: () => BuildFacts
  /** Replaces the served build, or serves the real one again on `reset`. */
  deploy: (mode: DeployMode) => BuildFacts
}

/** Owns what the dev server serves: the real build until a simulated deploy replaces it. */
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
