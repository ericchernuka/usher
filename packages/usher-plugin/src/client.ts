import { runningBuild as embeddedBuild, versionUrl } from 'virtual:usher'
import {
  createAppUpdates as createCoreUpdates,
  type AppUpdates,
  type AppUpdatesOptions,
  type BuildFacts,
  type Tab,
} from '@rndsqr/usher-core'
import type { DeployMode } from './simulated-deploy'

declare global {
  /**
   * Simulated deploys for the page, present while `vite` serves an app
   * built with `usher({ devtools: true })`
   */
  var __USHER_DEVTOOLS__:
    | { deploy: (request?: { mode?: DeployMode }) => Promise<BuildFacts> }
    | undefined
}

/** Build facts of the running build, e.g. for tagging error reports and RUM events. */
export const runningBuild: BuildFacts = embeddedBuild

export function createAppUpdates(
  options: Omit<AppUpdatesOptions, 'running' | 'versionUrl'> = {},
  tab?: Tab,
): AppUpdates {
  return createCoreUpdates(
    { ...options, running: embeddedBuild, versionUrl },
    tab,
  )
}
