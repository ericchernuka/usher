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
  /** Never `unknown`: a decision needs a latest build. */
  state: Exclude<UpdateState, { reason: 'unknown' }>
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

const after = (start: number | undefined, duration: number | undefined) =>
  start === undefined || duration === undefined ? undefined : start + duration

/** The server times at which the attention of a tab outdated since `since` can change. */
function changeTimes(input: AttentionInput, since: number) {
  return {
    promptStart: after(since, input.thresholds.promptAfter),
    urgentStart: after(since, input.thresholds.urgentAfter),
    promptUntil: after(input.dismissedAt, input.thresholds.promptSnooze),
  }
}

type ChangeTimes = ReturnType<typeof changeTimes>

function escalation(
  { now, latest, dismissedAt }: AttentionInput,
  { promptStart, urgentStart, promptUntil }: ChangeTimes,
): Decision['state'] {
  if (urgentStart !== undefined && now >= urgentStart) {
    return { attention: 'urgent', reason: 'outdated', latest }
  }

  if (promptStart === undefined || now < promptStart) {
    return { attention: 'passive', reason: 'outdated', latest }
  }

  const dismissed =
    dismissedAt !== undefined &&
    dismissedAt >= promptStart &&
    (promptUntil === undefined || now < promptUntil)

  return dismissed
    ? { attention: 'passive', reason: 'dismissed', latest }
    : { attention: 'prompt', reason: 'outdated', latest }
}

function nextChange(times: ChangeTimes, now: number) {
  const upcoming = Object.values(times).flatMap(time =>
    time !== undefined && time > now ? [time] : [],
  )

  return upcoming.length ? Math.min(...upcoming) : undefined
}

export function resolveAttention(input: AttentionInput): Decision {
  const { now, latest } = input
  const stickyUrgency = detectSticky(input)

  const outdatedSince = isSuperseded(input)
    ? (input.outdatedSince ?? supersededAt(input))
    : undefined

  const decision = (state: Decision['state'], nextAt?: number): Decision => ({
    state,
    stickyUrgency,
    outdatedSince,
    nextAt,
  })

  if (stickyUrgency) {
    return decision({ attention: 'urgent', reason: stickyUrgency, latest })
  }

  if (outdatedSince === undefined) {
    return decision({ attention: 'none', reason: 'caught-up', latest })
  }

  const times = changeTimes(input, outdatedSince)
  const state = escalation(input, times)

  return decision(
    state,
    state.attention === 'urgent' ? undefined : nextChange(times, now),
  )
}
