import type { Thresholds } from './options'
import type { BuildFacts, UpdateState } from './types'

export type StickyUrgency = 'rollback' | 'forced'

export interface AttentionInput {
  running: BuildFacts
  latest: BuildFacts
  now: number
  stickyUrgency: StickyUrgency | undefined
  /** What an earlier decision returned as `outdatedSince`, if the tab was already outdated. */
  outdatedSince: number | undefined
  dismissedAt: number | undefined
  thresholds: Thresholds
}

export interface Decision {
  state: UpdateState
  /** Rollback or forced-update knowledge to keep until the tab reloads. */
  stickyUrgency: StickyUrgency | undefined
  /**
   * Server time from which the tab counts as outdated: the build time of the
   * first build seen to supersede the running one. Later deploys do not move
   * it, and catching up clears it.
   */
  outdatedSince: number | undefined
  /** Server time at which attention next changes on its own, if it will. */
  nextAt: number | undefined
}

function detectSticky(input: AttentionInput): StickyUrgency | undefined {
  const cutoff = Date.parse(input.latest.forceUpdateBuiltBefore ?? '')

  // A cutoff later than the serving build itself could never be satisfied by
  // refreshing, so it is ignored instead of nagging every tab forever.
  if (
    cutoff > Date.parse(input.running.buildTime) &&
    cutoff <= Date.parse(input.latest.buildTime)
  ) {
    return 'forced'
  }

  if (
    Date.parse(input.latest.commitTime) < Date.parse(input.running.commitTime)
  ) {
    return 'rollback'
  }

  return input.stickyUrgency
}

function promptUntil(input: AttentionInput): number | undefined {
  const at = input.dismissedAt
  const snooze = input.thresholds.promptSnooze

  return at !== undefined && snooze !== undefined ? at + snooze : undefined
}

/**
 * A tab is outdated from the moment a newer build was made, not from the moment
 * its own build was made: a fresh tab on a week-old build is one minute behind
 * when the next deploy lands. The first superseding build sets the time, so a
 * team that deploys a hundred times a day still escalates.
 */
function outdatedSince(input: AttentionInput): number | undefined {
  if (input.latest.version === input.running.version) {
    return undefined
  }

  return (
    input.outdatedSince ??
    Math.max(
      Date.parse(input.running.buildTime),
      Date.parse(input.latest.buildTime),
    )
  )
}

interface Outdated {
  input: AttentionInput
  since: number
}

/** Server time at which a level starts, if the level is on. */
function startOf(
  { input, since }: Outdated,
  level: 'promptAfter' | 'urgentAfter',
) {
  const after = input.thresholds[level]

  return after === undefined ? undefined : since + after
}

function nextAt(outdated: Outdated): number | undefined {
  const serverTimes = [
    startOf(outdated, 'promptAfter'),
    startOf(outdated, 'urgentAfter'),
    promptUntil(outdated.input),
  ]

  const future = serverTimes.flatMap(time =>
    time !== undefined && time > outdated.input.now ? [time] : [],
  )

  return future.length ? Math.min(...future) : undefined
}

function attention(outdated: Outdated): UpdateState {
  const { input } = outdated
  const latest = input.latest
  const promptStart = startOf(outdated, 'promptAfter')
  const urgentStart = startOf(outdated, 'urgentAfter')

  if (urgentStart !== undefined && input.now >= urgentStart) {
    return { attention: 'urgent', reason: 'outdated', latest }
  }

  if (promptStart === undefined || input.now < promptStart) {
    return { attention: 'passive', reason: 'outdated', latest }
  }

  const dismissedAt = input.dismissedAt
  const until = promptUntil(input)

  const dismissed =
    dismissedAt !== undefined &&
    dismissedAt >= promptStart &&
    (until === undefined || input.now < until)

  return dismissed
    ? { attention: 'passive', reason: 'dismissed', latest }
    : { attention: 'prompt', reason: 'outdated', latest }
}

export function resolveAttention(input: AttentionInput): Decision {
  const stickyUrgency = detectSticky(input)
  const since = outdatedSince(input)
  const latest = input.latest

  if (stickyUrgency) {
    return {
      state: { attention: 'urgent', reason: stickyUrgency, latest },
      stickyUrgency,
      outdatedSince: since,
      nextAt: undefined,
    }
  }

  if (since === undefined) {
    return {
      state: { attention: 'none', reason: 'caught-up', latest },
      stickyUrgency,
      outdatedSince: since,
      nextAt: undefined,
    }
  }

  const outdated = { input, since }
  const state = attention(outdated)

  return {
    state,
    stickyUrgency,
    outdatedSince: since,
    nextAt: state.attention === 'urgent' ? undefined : nextAt(outdated),
  }
}
