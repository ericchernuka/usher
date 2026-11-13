import {
  isForcedUpdate,
  isRollback,
  isSuperseded,
  supersededAt,
  type Builds,
} from './build-facts'
import type { Thresholds } from './options'
import type { UpdateState } from './types'

export type StickyUrgency = 'rollback' | 'forced'

export interface AttentionInput extends Builds {
  now: number
  stickyUrgency: StickyUrgency | undefined
  outdatedSince: number | undefined
  dismissedAt: number | undefined
  thresholds: Thresholds
}

export interface Decision {
  state: UpdateState
  stickyUrgency: StickyUrgency | undefined
  outdatedSince: number | undefined
  nextAt: number | undefined
}

function detectSticky(input: AttentionInput): StickyUrgency | undefined {
  if (isForcedUpdate(input)) {
    return 'forced'
  }

  if (isRollback(input)) {
    return 'rollback'
  }

  return input.stickyUrgency
}

function promptUntil(input: AttentionInput): number | undefined {
  const at = input.dismissedAt
  const snooze = input.thresholds.promptSnooze

  return at !== undefined && snooze !== undefined ? at + snooze : undefined
}

function outdatedSince(input: AttentionInput): number | undefined {
  return isSuperseded(input)
    ? (input.outdatedSince ?? supersededAt(input))
    : undefined
}

interface Outdated {
  input: AttentionInput
  since: number
}

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
