import * as v from 'valibot'
import type { ResolvedEscalation } from './duration'
import { VersionInfoSchema, type UpdateState, type VersionInfo } from './types'

export interface Snoozes {
  promptAt?: number
}

export type KnownBad = 'rollback' | 'forced'

export interface PolicyInput {
  current: VersionInfo
  latest: VersionInfo
  now: number
  clockOffset: number
  knownBad?: KnownBad
  snoozes: Snoozes
  escalation: ResolvedEscalation
}

export interface Decision {
  state: UpdateState
  knownBad?: KnownBad
  nextAt?: number
}

function detectBad(i: PolicyInput): KnownBad | undefined {
  const cutoff = Date.parse(i.latest.forceUpdateBefore ?? '')

  if (cutoff > Date.parse(i.current.builtAt)) {
    return 'forced'
  }

  if (Date.parse(i.latest.commitTime) < Date.parse(i.current.commitTime)) {
    return 'rollback'
  }

  return i.knownBad
}

function promptUntil(i: PolicyInput): number | undefined {
  const at = i.snoozes.promptAt
  const duration = i.escalation.prompt?.snoozeMs

  return at !== undefined && duration !== undefined ? at + duration : undefined
}

function nextAt(i: PolicyInput): number | undefined {
  const builtAt = Date.parse(i.current.builtAt)

  const serverTimes = [
    i.escalation.prompt && builtAt + i.escalation.prompt.afterMs,
    i.escalation.urgent && builtAt + i.escalation.urgent.afterMs,
    promptUntil(i),
  ]

  const future = serverTimes.flatMap(time => {
    if (time === undefined || !Number.isFinite(time)) {
      return []
    }

    const client = time - i.clockOffset

    return client > i.now ? [client] : []
  })

  return future.length ? Math.min(...future) : undefined
}

function attention(i: PolicyInput): UpdateState {
  const latest = i.latest

  if (latest.version === i.current.version) {
    return { attention: 'none', reason: 'caught-up', latest }
  }

  const serverNow = i.now + i.clockOffset
  const builtAt = Date.parse(i.current.builtAt)
  const { prompt, urgent } = i.escalation

  if (urgent && serverNow >= builtAt + urgent.afterMs) {
    return { attention: 'urgent', reason: 'expired', latest }
  }

  if (!prompt || serverNow < builtAt + prompt.afterMs) {
    return { attention: 'passive', reason: 'new-build', latest }
  }

  const dismissedAt = i.snoozes.promptAt
  const until = promptUntil(i)

  const dismissed =
    dismissedAt !== undefined &&
    dismissedAt >= builtAt + prompt.afterMs &&
    (until === undefined || serverNow < until)

  return dismissed
    ? { attention: 'passive', reason: 'dismiss', latest }
    : { attention: 'prompt', reason: 'stale', latest }
}

export function decide(i: PolicyInput): Decision {
  const knownBad = detectBad(i)

  if (knownBad) {
    return {
      state: { attention: 'urgent', reason: knownBad, latest: i.latest },
      knownBad,
    }
  }

  const state = attention(i)

  const deadline =
    state.attention === 'none' || state.attention === 'urgent'
      ? undefined
      : nextAt(i)

  return { state, ...(deadline !== undefined && { nextAt: deadline }) }
}

export function isVersionInfo(value: unknown): value is VersionInfo {
  return v.is(VersionInfoSchema, value)
}
