import { execSync } from 'node:child_process'
import * as v from 'valibot'
import type { BuildFacts } from '@app-version/core'

/** Explicit values that win over the environment and Git. */
export interface BuildFactsSources {
  version?: string
  commitTime?: string
  forceUpdateBefore?: string
}

const git = (args: string) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return undefined
  }
}

const Present = v.pipe(v.string(), v.trim(), v.nonEmpty())

const Timestamp = v.pipe(
  Present,
  v.isoTimestamp(),
  v.transform(value => new Date(value).toISOString()),
)

type Source = readonly [name: string, value: string | undefined]

function firstSet(...sources: ReadonlyArray<Source>) {
  for (const [name, value] of sources) {
    const result = v.safeParse(Present, value)

    if (result.success) {
      return { name, value: result.output }
    }
  }

  return undefined
}

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

export interface BuildFactsRuntime {
  env?: NodeJS.ProcessEnv
  now?: Date
  warn?: ((message: string) => void) | undefined
}

function buildVersion(version: { value: string } | undefined, now: Date) {
  return version?.value ?? `dev-${now.getTime()}`
}

export function resolveBuildFacts(
  sources: BuildFactsSources = {},
  { env = process.env, now = new Date(), warn }: BuildFactsRuntime = {},
): BuildFacts {
  const version = firstSet(
    ['version', sources.version],
    ['APP_VERSION', env['APP_VERSION']],
    ['GITHUB_SHA', env['GITHUB_SHA']],
    ['git rev-parse HEAD', git('rev-parse HEAD')],
  )

  const commitTime = timestamp(
    firstSet(
      ['commitTime', sources.commitTime],
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
      ['forceUpdateBefore', sources.forceUpdateBefore],
      ['APP_FORCE_UPDATE_BEFORE', env['APP_FORCE_UPDATE_BEFORE']],
    ),
  )

  const facts: BuildFacts = {
    version: buildVersion(version, now),
    commitTime: commitTime ?? now.toISOString(),
    buildTime: now.toISOString(),
  }

  if (forceUpdateBefore) {
    facts.forceUpdateBefore = forceUpdateBefore
  }

  return facts
}
