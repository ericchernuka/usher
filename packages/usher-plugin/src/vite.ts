import type { Plugin, ResolvedConfig } from 'vite'
import type { BuildFacts } from '@rndsqr/usher-core'
import type { SkewProtectionAdapter } from './adapter'
import { adapterFiles, writePrivateFiles } from './adapter-files'
import { resolveBuildFacts } from './build-facts'
import { isRelativeBase, versionMiddleware } from './dev-server'

export interface UsherPluginOptions {
  /** Output file name, relative to outDir and `base`. Default "version.json". */
  fileName?: string
  /** Override the version. Default: APP_VERSION, GITHUB_SHA, then `git rev-parse HEAD`. */
  version?: string
  /** Override the commit time (ISO). Default: APP_COMMIT_TIME, then `git log -1 --format=%cI`. */
  commitTime?: string
  /**
   * Force tabs built before this time (ISO) to update. It is a build time, not a
   * deadline, so a value later than this build fails the build.
   * Default: APP_FORCE_UPDATE_BUILT_BEFORE.
   */
  forceUpdateBuiltBefore?: string
  /**
   * Serve chunks from older builds after a deploy, e.g. `cloudflarePages()` from
   * `@rndsqr/usher-cloudflare`. Off by default.
   */
  adapter?: SkewProtectionAdapter
}

const VIRTUAL_ID = 'virtual:usher'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

interface HookEnvironment {
  readonly environment?: { readonly config: { readonly consumer?: string } }
}

function isServerBuild(config: ResolvedConfig, hook: HookEnvironment) {
  return (
    Boolean(config.build.ssr) || hook.environment?.config.consumer === 'server'
  )
}

const relativeBaseWarning = (base: string, fileName: string) =>
  `[usher] base "${base}" is relative; ${fileName} is resolved from the page URL.`

/**
 * Writes `version.json` into the client build and embeds the same build facts
 * in the bundle, so the running build and the polled file always agree.
 */
export function usher(options: UsherPluginOptions = {}): Plugin {
  const fileName = options.fileName ?? 'version.json'
  let config: ResolvedConfig
  let facts: BuildFacts

  return {
    name: 'usher',
    configResolved(resolved) {
      config = resolved
      facts = resolveBuildFacts(options, {
        warn: message => resolved.logger.warn(message),
      })

      if (isRelativeBase(config.base)) {
        config.logger.warn(relativeBaseWarning(config.base, fileName))
      }
    },
    resolveId: id => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
    load(id) {
      if (id !== RESOLVED_ID) {
        return undefined
      }

      return `export const runningBuild = ${JSON.stringify(facts)};\nexport const versionUrl = ${JSON.stringify(config.base + fileName)};\n`
    },
    configureServer(server) {
      server.middlewares.use(versionMiddleware(config.base, fileName, facts))
    },
    generateBundle() {
      if (isServerBuild(config, this)) {
        return
      }

      this.emitFile({
        type: 'asset',
        fileName,
        source: `${JSON.stringify(facts, null, 2)}\n`,
      })

      const adapter = options.adapter

      if (!adapter) {
        return
      }

      const files = adapterFiles(adapter, config)

      if (files.error) {
        this.error(files.error)
      }

      files.warnings.forEach(warning => config.logger.warn(warning))

      for (const file of files.clientFiles) {
        this.emitFile({
          type: 'asset',
          fileName: file.fileName,
          source: file.source,
        })
      }
    },
    writeBundle() {
      const adapter = options.adapter

      if (adapter && !isServerBuild(config, this)) {
        writePrivateFiles(adapterFiles(adapter, config).privateFiles)
      }
    },
  }
}
