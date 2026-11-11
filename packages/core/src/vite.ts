import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import * as v from 'valibot'
import type { Plugin, ResolvedConfig } from 'vite'
import type { SkewProtectionAdapter, SkewProtectionContext } from './adapter'
import type { VersionInfo } from './types'

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
  /** Override the commit time (ISO). Default: `git log -1 --format=%cI`. */
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

const git = (args: string) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return undefined
  }
}

/** A set value: "" and whitespace (an unset CI variable) count as missing. */
const Present = v.pipe(v.string(), v.trim(), v.nonEmpty())
const Timestamp = v.pipe(
  Present,
  v.isoTimestamp(),
  v.transform(value => new Date(value).toISOString()),
)

/** Where a setting came from, so a bad value names its source. */
type Source = readonly [name: string, value: string | undefined]

/** The first source that is set, trimmed. */
function firstSet(...sources: ReadonlyArray<Source>) {
  for (const [name, value] of sources) {
    const result = v.safeParse(Present, value)
    if (result.success) return { name, value: result.output }
  }
  return undefined
}

/** A set source as a normalized ISO timestamp; a malformed one fails the build by name. */
function timestamp(source: { name: string; value: string } | undefined) {
  if (!source) return undefined
  const result = v.safeParse(Timestamp, source.value)
  if (!result.success) {
    throw new Error(
      `[app-version] ${source.name} must be an ISO 8601 timestamp, got "${source.value}".`,
    )
  }
  return result.output
}

export function resolveVersionInfo(
  opts: AppVersionOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  warn?: (message: string) => void,
): VersionInfo {
  const version = firstSet(
    ['version', opts.version],
    ['APP_VERSION', env['APP_VERSION']],
    ['GITHUB_SHA', env['GITHUB_SHA']],
    ['git rev-parse HEAD', git('rev-parse HEAD')],
  )
  // Commit time orders builds for rollback detection, so "now" is only a last resort.
  const commitTime = timestamp(
    firstSet(
      ['commitTime', opts.commitTime],
      ['APP_COMMIT_TIME', env['APP_COMMIT_TIME']],
      ['git log', git('log -1 --format=%cI')],
    ),
  )
  if (!commitTime) {
    warn?.(
      '[app-version] no commit time (no .git and no APP_COMMIT_TIME); using build time. ' +
        "Redeploying an old commit won't be detected as a rollback.",
    )
  }
  const forceUpdateBefore = timestamp(
    firstSet(
      ['forceUpdateBefore', opts.forceUpdateBefore],
      ['APP_FORCE_UPDATE_BEFORE', env['APP_FORCE_UPDATE_BEFORE']],
    ),
  )
  return {
    version: version?.value ?? `dev-${now.getTime()}`,
    commitTime: commitTime ?? now.toISOString(),
    builtAt: now.toISOString(),
    ...(forceUpdateBefore ? { forceUpdateBefore } : {}),
  }
}

/**
 * Writes `version.json` into the client build and exposes the same info as
 * `virtual:app-version`, so the running bundle and the polled file always agree.
 */
export function appVersion(opts: AppVersionOptions = {}): Plugin {
  const fileName = opts.fileName ?? 'version.json'
  let config: ResolvedConfig
  let info: VersionInfo
  let url: string

  /** URL path of `base`, e.g. "/" or "/app/" (a CDN base keeps only its path). Vite always ends `base` in "/". */
  const pathBase = () =>
    /^https?:/.test(config.base) ? new URL(config.base).pathname : config.base
  const skewContext = (
    fail: (message: string) => never,
  ): SkewProtectionContext => ({
    base: pathBase(),
    assetsDir: config.build.assetsDir,
    root: config.root,
    outDir: resolve(config.root, config.build.outDir),
    logger: config.logger,
    error: fail,
  })

  return {
    name: 'app-version',
    configResolved(resolved) {
      config = resolved
      info = resolveVersionInfo(opts, process.env, new Date(), m =>
        resolved.logger.warn(m),
      )
      if (!config.base.startsWith('/') && !/^https?:/.test(config.base)) {
        config.logger.warn(
          `[app-version] base "${config.base}" is relative; ${fileName} is resolved from the page URL.`,
        )
      }
      url = config.base + fileName // Vite always ends `base` in "/"
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined
      return `export const appVersion = ${JSON.stringify(info)};\nexport const versionUrl = ${JSON.stringify(url)};\n`
    },
    configureServer(server) {
      // Dev serves the same build info, so the watcher sees "up to date".
      server.middlewares.use((req, res, next) => {
        // Compare paths: with a CDN `base` the url is absolute, and with a relative base it
        // resolves against the page, but requests always arrive as paths.
        const path = req.url?.split('?')[0] ?? ''
        const relativeBase =
          !config.base.startsWith('/') && !/^https?:/.test(config.base)
        if (
          relativeBase
            ? !path.endsWith(`/${fileName}`)
            : path !== `${pathBase()}${fileName}`
        )
          return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(info))
      })
    },
    generateBundle() {
      if (config.build.ssr || isServerBuild(this)) return
      this.emitFile({
        type: 'asset',
        fileName,
        source: `${JSON.stringify(info, null, 2)}\n`,
      })

      const assets =
        opts.skewProtection?.bundleAssets?.(skewContext(m => this.error(m))) ??
        []
      for (const asset of assets) this.emitFile({ type: 'asset', ...asset })
    },
    writeBundle() {
      if (config.build.ssr || isServerBuild(this)) return
      opts.skewProtection?.writeBundle?.(skewContext(m => this.error(m)))
    },
  }
}

/** The slice of a Vite 6+ hook context that names its environment (absent on Vite 5). */
interface HookEnvironment {
  readonly environment?: { readonly config: { readonly consumer?: string } }
}

function isServerBuild(ctx: HookEnvironment) {
  return ctx.environment?.config.consumer === 'server'
}
