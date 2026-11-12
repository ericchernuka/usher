import { runningBuild, versionUrl } from 'virtual:app-version'
import {
  createAppUpdates as createCoreUpdates,
  type AppUpdates,
  type AppUpdatesOptions,
} from '@app-version/core'

/** Create the update store using build facts supplied by the Vite plugin. */
export function createAppUpdates(
  options: Omit<AppUpdatesOptions, 'running' | 'versionUrl'> = {},
): AppUpdates {
  return createCoreUpdates({ ...options, running: runningBuild, versionUrl })
}
