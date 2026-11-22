import type { Plugin, ResolvedConfig, Rollup } from 'vite'
import type { BuildFacts } from '@rndsqr/usher-core'
import type { SkewProtectionAdapter } from './adapter'
import {
  planAdapterFiles,
  writePrivateFiles,
  type AdapterFilePlan,
} from './adapter-files'
import { resolveBuildFacts } from './build-facts'
import { buildLayout, type BuildLayout } from './build-layout'
import { serveDevelopment } from './dev-server'
import { devtoolsTags } from './devtools'

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
  /**
   * Development only: adds `__USHER_DEVTOOLS__.deploy()` to the page, which makes
   * the dev server serve a simulated deploy (`advance`, `force`, `rollback`, or
   * `reset`) from the version URL. Production builds are unchanged. Off by default.
   */
  devtools?: boolean
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

function layoutOf(config: ResolvedConfig, fileName: string): BuildLayout {
  const layout = buildLayout({
    base: config.base,
    assetsDir: config.build.assetsDir,
    fileName,
  })

  if (!layout.paths) {
    config.logger.warn(
      `[usher] base "${config.base}" is relative; ${fileName} is resolved from the page URL.`,
    )
  }

  return layout
}

function emitAdapterFiles(
  context: Pick<Rollup.PluginContext, 'emitFile'>,
  plan: AdapterFilePlan,
  config: ResolvedConfig,
) {
  plan.warnings.forEach(warning => config.logger.warn(warning))

  for (const file of plan.clientFiles) {
    context.emitFile({
      type: 'asset',
      fileName: file.fileName,
      source: file.source,
    })
  }
}

/**
 * Writes `version.json` into the client build and embeds the same build facts
 * in the bundle, so the running build and the polled file always agree.
 */
export function usher(options: UsherPluginOptions = {}): Plugin {
  const fileName = options.fileName ?? 'version.json'
  let config: ResolvedConfig
  let facts: BuildFacts
  let layout: BuildLayout

  const adapterPlan = (adapter: SkewProtectionAdapter) =>
    planAdapterFiles(adapter, {
      layout,
      root: config.root,
      outDir: config.build.outDir,
    })

  return {
    name: 'usher',
    configResolved(resolved) {
      config = resolved
      facts = resolveBuildFacts(options, {
        warn: message => resolved.logger.warn(message),
      })

      layout = layoutOf(config, fileName)
    },
    resolveId: id => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
    load(id) {
      if (id !== RESOLVED_ID) {
        return undefined
      }

      return `export const runningBuild = ${JSON.stringify(facts)};\nexport const versionUrl = ${JSON.stringify(layout.versionUrl)};\n`
    },
    configureServer(server) {
      serveDevelopment(server.middlewares, {
        base: config.base,
        versionUrl: layout.versionUrl,
        facts,
        devtools: options.devtools ?? false,
      })
    },
    transformIndexHtml: () =>
      options.devtools && config.command === 'serve'
        ? devtoolsTags(config.base)
        : undefined,
    generateBundle() {
      if (isServerBuild(config, this)) {
        return
      }

      this.emitFile({
        type: 'asset',
        fileName,
        source: `${JSON.stringify(facts, null, 2)}\n`,
      })

      if (options.adapter) {
        emitAdapterFiles(this, adapterPlan(options.adapter), config)
      }
    },
    writeBundle() {
      const adapter = options.adapter

      if (adapter && !isServerBuild(config, this)) {
        writePrivateFiles(adapterPlan(adapter).privateFiles)
      }
    },
  }
}
