import type { Thresholds } from './options'
import type { BuildFacts, UpdateState } from './types'

export type StickyUrgency = 'rollback' | 'forced'

export interface AttentionInput {
  running: BuildFacts
  latest: BuildFacts
  now: number
  stickyUrgency: StickyUrgency | undefined
  dismissedAt: number | undefined
  thresholds: Thresholds
}

export interface Decision {
  state: UpdateState
  /** Rollback or forced-update knowledge to keep until the tab reloads. */
  stickyUrgency: StickyUrgency | undefined
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

/** Server time at which an age level starts, if the level is on. */
function startOf(input: AttentionInput, level: 'promptAfter' | 'urgentAfter') {
  const after = input.thresholds[level]

  return after === undefined
    ? undefined
    : Date.parse(input.running.buildTime) + after
}

function nextAt(input: AttentionInput): number | undefined {
  const serverTimes = [
    startOf(input, 'promptAfter'),
    startOf(input, 'urgentAfter'),
    promptUntil(input),
  ]

  const future = serverTimes.flatMap(time => {
    if (time === undefined || !Number.isFinite(time)) {
      return []
    }

    return time > input.now ? [time] : []
  })

  return future.length ? Math.min(...future) : undefined
}

function attention(input: AttentionInput): UpdateState {
  const latest = input.latest

  if (latest.version === input.running.version) {
    return { attention: 'none', reason: 'caught-up', latest }
  }

  const promptStart = startOf(input, 'promptAfter')
  const urgentStart = startOf(input, 'urgentAfter')

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

  if (stickyUrgency) {
    return {
      state: {
        attention: 'urgent',
        reason: stickyUrgency,
        latest: input.latest,
      },
      stickyUrgency,
      nextAt: undefined,
    }
  }

  const state = attention(input)

  return {
    state,
    stickyUrgency: undefined,
    nextAt:
      state.attention === 'none' || state.attention === 'urgent'
        ? undefined
        : nextAt(input),
  }
}
