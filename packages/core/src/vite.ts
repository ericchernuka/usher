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

export interface VersionConfig {
  base: string
  root: string
  build: Pick<ResolvedConfig['build'], 'assetsDir' | 'outDir' | 'ssr'>
  logger: ResolvedConfig['logger']
}

export interface VersionServer {
  middlewares: {
    use(
      handler: (
        req: { url?: string | undefined },
        res: {
          setHeader(name: string, value: string): void
          end(body: string): void
        },
        next: () => void,
      ) => void,
    ): void
  }
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

    if (result.success) {
      return { name, value: result.output }
    }
  }

  return undefined
}

/** A set source as a normalized ISO timestamp; a malformed one fails the build by name. */
function timestamp(source: { name: string; value: string } | undefined) {
  if (!source) {
    return undefined
  }

  const result = v.safeParse(Timestamp, source.value)

  if (!result.success) {
    throw new Error(
      `[app-version] ${source.name} must be an ISO 8601 timestamp, got "${source.value}".`,
    )
  }

  return result.output
}

/** What a build reads from its surroundings; tests substitute each. */
export interface VersionRuntime {
  env?: NodeJS.ProcessEnv
  now?: Date
  warn?: ((message: string) => void) | undefined
}

function buildVersion(version: { value: string } | undefined, now: Date) {
  return version?.value ?? `dev-${now.getTime()}`
}

export function resolveVersionInfo(
  opts: AppVersionOptions = {},
  { env = process.env, now = new Date(), warn }: VersionRuntime = {},
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

  const info: VersionInfo = {
    version: buildVersion(version, now),
    commitTime: commitTime ?? now.toISOString(),
    builtAt: now.toISOString(),
  }

  if (forceUpdateBefore) {
    info.forceUpdateBefore = forceUpdateBefore
  }

  return info
}

const isCdnBase = (base: string) => /^https?:/.test(base)

const isRelativeBase = (base: string) =>
  !base.startsWith('/') && !isCdnBase(base)

/** URL path of `base`, e.g. "/" or "/app/" (a CDN base keeps only its path). Vite always ends `base` in "/". */
const pathBase = (base: string) =>
  isCdnBase(base) ? new URL(base).pathname : base

/**
 * Whether a dev-server request is for the version file. Compare paths: with a CDN `base` the
 * url is absolute, and with a relative base it resolves against the page, but requests
 * always arrive as paths.
 */
function isVersionRequest(
  base: string,
  fileName: string,
  url: string | undefined,
) {
  const path = url?.split('?')[0] ?? ''

  return isRelativeBase(base)
    ? path.endsWith(`/${fileName}`)
    : path === `${pathBase(base)}${fileName}`
}

function skewContext(
  config: VersionConfig,
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

const resolveId = (id: string) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined)

/**
 * Writes `version.json` into the client build and exposes the same info as
 * `virtual:app-version`, so the running bundle and the polled file always agree.
 */
export function appVersion(opts: AppVersionOptions = {}) {
  const fileName = opts.fileName ?? 'version.json'
  let config: VersionConfig
  let info: VersionInfo

  return {
    name: 'app-version',
    configResolved(resolved: VersionConfig) {
      config = resolved
      info = resolveVersionInfo(opts, {
        warn: m => resolved.logger.warn(m),
      })

      if (isRelativeBase(config.base)) {
        config.logger.warn(
          `[app-version] base "${config.base}" is relative; ${fileName} is resolved from the page URL.`,
        )
      }
    },
    resolveId,
    load(id) {
      if (id !== RESOLVED_ID) {
        return undefined
      }

      return `export const appVersion = ${JSON.stringify(info)};\nexport const versionUrl = ${JSON.stringify(config.base + fileName)};\n`
    },
    configureServer(server: VersionServer) {
      // Dev serves the same build info, so the watcher sees "up to date".
      server.middlewares.use(versionMiddleware(config.base, fileName, info))
    },
    generateBundle() {
      if (config.build.ssr || isServerBuild(this)) {
        return
      }

      this.emitFile({
        type: 'asset',
        fileName,
        source: `${JSON.stringify(info, null, 2)}\n`,
      })

      const context = skewContext(config, m => this.error(m))
      const assets = opts.skewProtection?.bundleAssets?.(context) ?? []

      for (const asset of assets) {
        this.emitFile({ type: 'asset', ...asset })
      }
    },
    writeBundle() {
      if (config.build.ssr || isServerBuild(this)) {
        return
      }

      opts.skewProtection?.writeBundle?.(
        skewContext(config, m => this.error(m)),
      )
    },
  } satisfies Plugin
}

/** The slice of a Vite 6+ hook context that names its environment (absent on Vite 5). */
interface HookEnvironment {
  readonly environment?: { readonly config: { readonly consumer?: string } }
}

function isServerBuild(ctx: HookEnvironment) {
  return ctx.environment?.config.consumer === 'server'
}

function versionMiddleware(
  base: string,
  fileName: string,
  info: VersionInfo,
): Parameters<VersionServer['middlewares']['use']>[0] {
  return (req, res, next) => {
    if (!isVersionRequest(base, fileName, req.url)) {
      return next()
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(info))
  }
}
