import { runningBuild as embeddedBuild, versionUrl } from 'virtual:usher'
import {
  createAppUpdates as createCoreUpdates,
  type AppUpdates,
  type AppUpdatesOptions,
  type BuildFacts,
  type Tab,
} from '@rndsqr/usher-core'

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
