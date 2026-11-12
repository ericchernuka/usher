import type { Thresholds } from './options'
import type { PromptDismissal } from './prompt-dismissal'
import type { BuildFacts, UpdateState } from './types'

export type StickyUrgency = 'rollback' | 'forced'

export interface AttentionInput {
  running: BuildFacts
  latest: BuildFacts
  now: number
  stickyUrgency?: StickyUrgency
  dismissal: PromptDismissal
  thresholds: Thresholds
}

export interface Decision {
  state: UpdateState
  stickyUrgency?: StickyUrgency
  nextAt?: number
}

function detectBad(i: AttentionInput): StickyUrgency | undefined {
  const cutoff = Date.parse(i.latest.forceUpdateBefore ?? '')

  if (cutoff > Date.parse(i.running.buildTime)) {
    return 'forced'
  }

  if (Date.parse(i.latest.commitTime) < Date.parse(i.running.commitTime)) {
    return 'rollback'
  }

  return i.stickyUrgency
}

function promptUntil(i: AttentionInput): number | undefined {
  const at = i.dismissal.dismissedAt
  const snooze = i.thresholds.promptSnooze

  return at !== undefined && snooze !== undefined ? at + snooze : undefined
}

/** Server time at which an age level starts, if the level is on. */
function startOf(i: AttentionInput, level: 'promptAfter' | 'urgentAfter') {
  const after = i.thresholds[level]

  return after === undefined
    ? undefined
    : Date.parse(i.running.buildTime) + after
}

function nextAt(i: AttentionInput): number | undefined {
  const serverTimes = [
    startOf(i, 'promptAfter'),
    startOf(i, 'urgentAfter'),
    promptUntil(i),
  ]

  const future = serverTimes.flatMap(time => {
    if (time === undefined || !Number.isFinite(time)) {
      return []
    }

    return time > i.now ? [time] : []
  })

  return future.length ? Math.min(...future) : undefined
}

function attention(i: AttentionInput): UpdateState {
  const latest = i.latest

  if (latest.version === i.running.version) {
    return { attention: 'none', reason: 'caught-up', latest }
  }

  const promptStart = startOf(i, 'promptAfter')
  const urgentStart = startOf(i, 'urgentAfter')

  if (urgentStart !== undefined && i.now >= urgentStart) {
    return { attention: 'urgent', reason: 'outdated', latest }
  }

  if (promptStart === undefined || i.now < promptStart) {
    return { attention: 'passive', reason: 'outdated', latest }
  }

  const dismissedAt = i.dismissal.dismissedAt
  const until = promptUntil(i)

  const dismissed =
    dismissedAt !== undefined &&
    dismissedAt >= promptStart &&
    (until === undefined || i.now < until)

  return dismissed
    ? { attention: 'passive', reason: 'dismissed', latest }
    : { attention: 'prompt', reason: 'outdated', latest }
}

export function resolveAttention(i: AttentionInput): Decision {
  const stickyUrgency = detectBad(i)

  if (stickyUrgency) {
    return {
      state: { attention: 'urgent', reason: stickyUrgency, latest: i.latest },
      stickyUrgency,
    }
  }

  const state = attention(i)

  const deadline =
    state.attention === 'none' || state.attention === 'urgent'
      ? undefined
      : nextAt(i)

  return { state, ...(deadline !== undefined && { nextAt: deadline }) }
}
