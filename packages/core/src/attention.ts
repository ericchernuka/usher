import type { ResolvedEscalation } from './duration'
import type { PromptDismissal } from './prompt-dismissal'
import type { BuildFacts, UpdateState } from './types'

export type StickyUrgency = 'rollback' | 'forced'

export interface AttentionInput {
  running: BuildFacts
  latest: BuildFacts
  now: number
  stickyUrgency?: StickyUrgency
  dismissal: PromptDismissal
  escalation: ResolvedEscalation
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
  const duration = i.escalation.prompt?.snoozeMs

  return at !== undefined && duration !== undefined ? at + duration : undefined
}

function nextAt(i: AttentionInput): number | undefined {
  const buildTime = Date.parse(i.running.buildTime)

  const serverTimes = [
    i.escalation.prompt && buildTime + i.escalation.prompt.afterMs,
    i.escalation.urgent && buildTime + i.escalation.urgent.afterMs,
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

  const buildTime = Date.parse(i.running.buildTime)
  const { prompt, urgent } = i.escalation

  if (urgent && i.now >= buildTime + urgent.afterMs) {
    return { attention: 'urgent', reason: 'outdated', latest }
  }

  if (!prompt || i.now < buildTime + prompt.afterMs) {
    return { attention: 'passive', reason: 'outdated', latest }
  }

  const dismissedAt = i.dismissal.dismissedAt
  const until = promptUntil(i)

  const dismissed =
    dismissedAt !== undefined &&
    dismissedAt >= buildTime + prompt.afterMs &&
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
