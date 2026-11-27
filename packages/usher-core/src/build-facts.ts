import * as valibot from 'valibot'

const Timestamp = valibot.pipe(valibot.string(), valibot.isoTimestamp())

const BuildFactsSchema = valibot.object({
  /** Source version the build came from, usually a commit SHA. Separate builds can share one. */
  version: valibot.pipe(valibot.string(), valibot.nonEmpty()),
  /** Commit time (ISO). Orders builds: lower than the running build's = rollback. */
  commitTime: Timestamp,
  /** When the build ran (ISO). A running app is outdated from the build time of the first build that supersedes its own. */
  buildTime: Timestamp,
  /**
   * Running apps whose build ran before this time (ISO) must update. It is a build time,
   * not a deadline, and it cannot be later than this build's own `buildTime`.
   * Set via APP_FORCE_UPDATE_BUILT_BEFORE.
   */
  forceUpdateBuiltBefore: valibot.exactOptional(Timestamp),
})

/** Build facts shared by the running build and the serving deployment. */
export type BuildFacts = valibot.InferOutput<typeof BuildFactsSchema>

/** Reads build facts from untrusted input. Fields the schema does not know are dropped. */
export const parseBuildFacts = valibot.safeParser(BuildFactsSchema)

export function sameBuildFacts(next: BuildFacts, current: BuildFacts) {
  return valibot
    .keyof(BuildFactsSchema)
    .options.every(fact => next[fact] === current[fact])
}

/** A running app's build and the latest build it has seen served. */
export interface Builds {
  running: BuildFacts
  latest: BuildFacts
}

/** The latest build is not the one the app runs, so the app is outdated. */
export const isSuperseded = ({ running, latest }: Builds) =>
  latest.version !== running.version

/**
 * The time from which a running app that first sees `latest` counts as outdated: the
 * latest build's build time, and never earlier than the running build's own.
 */
export const supersededAt = ({ running, latest }: Builds) =>
  Math.max(Date.parse(running.buildTime), Date.parse(latest.buildTime))

/** The latest build's source commit is older than the running build's. */
export const isRollback = ({ running, latest }: Builds) =>
  Date.parse(latest.commitTime) < Date.parse(running.commitTime)

/**
 * The latest build declares a forced-update cutoff that covers the running
 * build. A cutoff later than the build that declares it is ignored, because
 * refreshing onto that build could never satisfy it.
 */
export function isForcedUpdate({ running, latest }: Builds) {
  const cutoff = Date.parse(latest.forceUpdateBuiltBefore ?? '')

  return (
    cutoff > Date.parse(running.buildTime) &&
    cutoff <= Date.parse(latest.buildTime)
  )
}
