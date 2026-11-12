import { appVersion, versionUrl } from 'virtual:app-version'
import {
  createAppUpdates as createCoreUpdates,
  type AppUpdates,
  type AppUpdatesOptions,
} from '@app-version/core'

/** Create the update store using build facts supplied by the Vite plugin. */
export function createAppUpdates(
  options: Omit<AppUpdatesOptions, 'current' | 'url'> = {},
): AppUpdates {
  return createCoreUpdates({ ...options, current: appVersion, url: versionUrl })
}
