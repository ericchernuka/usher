import { runningBuild as embeddedBuild, versionUrl } from 'virtual:app-version'
import {
  createAppUpdates as createCoreUpdates,
  type AppUpdates,
  type AppUpdatesOptions,
  type BuildFacts,
} from '@app-version/core'

/** Build facts of the running build, e.g. for tagging error reports and RUM events. */
export const runningBuild: BuildFacts = embeddedBuild

/**
 * Core's `createAppUpdates` with the running build and version URL filled in
 * by the plugin. Create one store at module scope.
 */
export function createAppUpdates(
  options: Omit<AppUpdatesOptions, 'running' | 'versionUrl'> = {},
): AppUpdates {
  return createCoreUpdates({
    ...options,
    running: embeddedBuild,
    versionUrl,
  })
}
