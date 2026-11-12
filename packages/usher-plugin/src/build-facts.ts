import { execSync } from 'node:child_process'
import * as valibot from 'valibot'
import type { BuildFacts } from '@rndsqr/usher-core'

/** Explicit values that win over the environment and Git. */
export interface BuildFactsSources {
  version?: string
  commitTime?: string
  forceUpdateBuiltBefore?: string
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

const Present = valibot.pipe(
  valibot.string(),
  valibot.trim(),
  valibot.nonEmpty(),
)

const Timestamp = valibot.pipe(
  Present,
  valibot.isoTimestamp(),
  valibot.transform(value => new Date(value).toISOString()),
)

type Source = readonly [name: string, value: string | undefined]

function firstSet(...sources: ReadonlyArray<Source>) {
  for (const [name, value] of sources) {
    const result = valibot.safeParse(Present, value)

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

  const result = valibot.safeParse(Timestamp, source.value)

  if (!result.success) {
    throw new Error(
      `[usher] ${source.name} must be an ISO 8601 timestamp, got "${source.value}".`,
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
      '[usher] no commit time (no .git and no APP_COMMIT_TIME); using build time. ' +
        "Redeploying an old commit won't be detected as a rollback. " +
        'Set APP_COMMIT_TIME or build inside the Git checkout.',
    )
  }

  const forceUpdateBuiltBefore = timestamp(
    firstSet(
      ['forceUpdateBuiltBefore', sources.forceUpdateBuiltBefore],
      ['APP_FORCE_UPDATE_BUILT_BEFORE', env['APP_FORCE_UPDATE_BUILT_BEFORE']],
    ),
  )

  const facts: BuildFacts = {
    version: buildVersion(version, now),
    commitTime: commitTime ?? now.toISOString(),
    buildTime: now.toISOString(),
  }

  if (forceUpdateBuiltBefore) {
    if (forceUpdateBuiltBefore > facts.buildTime) {
      throw new Error(
        `[usher] forceUpdateBuiltBefore (${forceUpdateBuiltBefore}) is later than this build (${facts.buildTime}). ` +
          'It is a build time, not a deadline: tabs on this build could never satisfy it. ' +
          'Use the time of this build, or of the last bad one.',
      )
    }

    facts.forceUpdateBuiltBefore = forceUpdateBuiltBefore
  }

  return facts
}
