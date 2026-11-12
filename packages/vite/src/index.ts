import { resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import type { BuildFacts } from '@app-version/core'
import type { SkewProtectionAdapter, SkewProtectionContext } from './adapter'
import { resolveBuildFacts } from './build-facts'
import { isRelativeBase, pathBase, versionMiddleware } from './dev-server'

export type {
  SkewProtectionAdapter,
  SkewProtectionAsset,
  SkewProtectionContext,
} from './adapter'

export interface AppVersionOptions {
  /** Output file name, relative to outDir and `base`. Default "version.json". */
  fileName?: string
  /** Override the version. Default: APP_VERSION, GITHUB_SHA, then `git rev-parse HEAD`. */
  version?: string
  /** Override the commit time (ISO). Default: APP_COMMIT_TIME, then `git log -1 --format=%cI`. */
  commitTime?: string
  /** Force tabs built before this time (ISO) to update. Default: APP_FORCE_UPDATE_BEFORE. */
  forceUpdateBefore?: string
  /**
   * Serve chunks from older builds after a deploy, e.g. `cloudflarePages()` from
   * `@app-version/cloudflare`. Off by default.
   */
  skewProtection?: SkewProtectionAdapter
}

const VIRTUAL_ID = 'virtual:app-version'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

function skewContext(
  config: ResolvedConfig,
  fail: (message: string) => never,
): SkewProtectionContext {
  return {
    base: pathBase(config.base),
    assetsDir: config.build.assetsDir,
    root: config.root,
    outDir: resolve(config.root, config.build.outDir),
    logger: config.logger,
    error: fail,
  }
}

interface HookEnvironment {
  readonly environment?: { readonly config: { readonly consumer?: string } }
}

function isServerBuild(config: ResolvedConfig, hook: HookEnvironment) {
  return (
    Boolean(config.build.ssr) || hook.environment?.config.consumer === 'server'
  )
}

/**
 * Writes `version.json` into the client build and embeds the same build facts
 * in the bundle, so the running build and the polled file always agree.
 */
export function appVersion(options: AppVersionOptions = {}): Plugin {
  const fileName = options.fileName ?? 'version.json'
  let config: ResolvedConfig
  let facts: BuildFacts

  return {
    name: 'app-version',
    configResolved(resolved) {
      config = resolved
      facts = resolveBuildFacts(options, {
        warn: message => resolved.logger.warn(message),
      })

      if (isRelativeBase(config.base)) {
        config.logger.warn(
          `[app-version] base "${config.base}" is relative; ${fileName} is resolved from the page URL.`,
        )
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

      const context = skewContext(config, m => this.error(m))
      const assets = options.skewProtection?.bundleAssets?.(context) ?? []

      for (const asset of assets) {
        this.emitFile({ type: 'asset', ...asset })
      }
    },
    writeBundle() {
      if (isServerBuild(config, this)) {
        return
      }

      options.skewProtection?.writeBundle?.(
        skewContext(config, m => this.error(m)),
      )
    },
  }
}
