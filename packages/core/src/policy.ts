// Internal. The pure update policy: given facts, what should attention be, what can be
// published right now, and when could the answer next change on its own?
import * as v from 'valibot'
import type { ResolvedEscalation } from './duration'
import {
  VersionInfoSchema,
  type Attention,
  type ReasonsByAttention,
  type VersionInfo,
} from './types'

/**
 * Dismissals, shared across tabs. All times are on the server clock, so tabs agree and
 * clock-offset jitter can't move them.
 *
 * `promptAt` / `urgentAt` record when a level was dismissed. A dismissal covers every
 * tab whose level had already started by then ("acknowledged"), until that tab's next
 * level, or the level's explicit snooze. A build that goes stale later prompts afresh.
 * `bad` acknowledges known-bad evidence per running build.
 */
export interface Snoozes {
  promptAt?: number
  urgentAt?: number
  bad?: Record<string, BadSnooze>
}

export interface BadSnooze {
  /** Evidence acknowledged ("rollback", "forced:<cutoff>"); new evidence breaks through. */
  evidence: string[]
  until: number
}

export type Bad = 'rollback' | 'forced'

/** Sticky knowledge that the running build is bad, with every piece of evidence seen. */
export interface KnownBad {
  reason: Bad
  evidence: string[]
}

/** A level and its reason; reasons always belong to their level. */
export type Level = {
  [A in Attention]: { attention: A; reason: ReasonsByAttention[A] }
}[Attention]

export interface PolicyInput {
  current: VersionInfo
  latest: VersionInfo
  /** Client clock (timers). */
  now: number
  /** Server clock − client clock; build age and snoozes are on the server clock. */
  clockOffset: number
  /** Sticky: once this tab learns its build is bad, it stays bad until it reloads. */
  knownBad?: KnownBad
  snoozes: Snoozes
  escalation: ResolvedEscalation
  /** What's published now, for the raise gate. */
  published: Attention
  /** Raises to prompt/urgent may only publish while the tab is visible and the user idle. */
  gateOpen: boolean
}

export interface Decision {
  /** What attention should be, ignoring the gate. */
  target: Level
  /** What may be published now: the target, or a truthful hold while the gate is closed. */
  publish: Level
  /** Known-bad state including this response's evidence (for the caller to keep). */
  bad?: KnownBad
  /** Future client times when the answer could change with no new input. */
  deadlines: number[]
}

export const rank: Record<Attention, number> = {
  none: 0,
  passive: 1,
  prompt: 2,
  urgent: 3,
}

const DAY_MS = 86_400_000

/** Evidence in this response that the running build is bad. */
function evidence(i: PolicyInput): { reason: Bad; key: string } | undefined {
  const cutoff = i.latest.forceUpdateBefore
    ? Date.parse(i.latest.forceUpdateBefore)
    : NaN
  if (cutoff > Date.parse(i.current.builtAt))
    return { reason: 'forced', key: `forced:${cutoff}` }
  if (Date.parse(i.latest.commitTime) < Date.parse(i.current.commitTime))
    return { reason: 'rollback', key: 'rollback' }
  return undefined
}

/** Sticky merge: evidence accumulates; new evidence sets the reason. */
function detectBad(i: PolicyInput): KnownBad | undefined {
  const fresh = evidence(i)
  if (!fresh || i.knownBad?.evidence.includes(fresh.key)) return i.knownBad
  return {
    reason: fresh.reason,
    evidence: [...(i.knownBad?.evidence ?? []), fresh.key],
  }
}

/** Server-clock times the running build's levels start. */
function starts(i: PolicyInput) {
  const builtAt = Date.parse(i.current.builtAt)
  const { prompt, urgent } = i.escalation
  return {
    prompt: prompt && builtAt + prompt.afterMs,
    urgent: urgent && builtAt + urgent.afterMs,
  }
}

/** Explicit prompt snooze, else none (holds until urgent), else a day when urgent is off. */
function promptSnoozeMs(e: ResolvedEscalation): number | undefined {
  return e.prompt?.snoozeMs ?? (e.urgent ? undefined : DAY_MS)
}

/** Server-clock time a dismissal stops muting, if it ever does on its own. */
function snoozeEnds(i: PolicyInput) {
  const { promptAt, urgentAt } = i.snoozes
  const p = promptSnoozeMs(i.escalation)
  return {
    prompt:
      promptAt !== undefined && p !== undefined ? promptAt + p : undefined,
    urgent:
      urgentAt !== undefined
        ? urgentAt + (i.escalation.urgent?.snoozeMs ?? DAY_MS)
        : undefined,
  }
}

/** Which dismissals are in force for this tab right now. */
function mutes(i: PolicyInput, bad: KnownBad | undefined) {
  const server = i.now + i.clockOffset
  const start = starts(i)
  const ends = snoozeEnds(i)
  const { promptAt, urgentAt } = i.snoozes
  const acked = (
    at: number | undefined,
    levelStart: number | undefined,
    end: number | undefined,
  ) =>
    at !== undefined &&
    levelStart !== undefined &&
    at >= levelStart &&
    (end === undefined || server < end)
  const ack = i.snoozes.bad?.[i.current.version]
  const badMuted =
    !!bad &&
    !!ack &&
    ack.until > server &&
    bad.evidence.every(e => ack.evidence.includes(e))
  const urgent = acked(urgentAt, start.urgent, ends.urgent) || badMuted
  return {
    bad: badMuted,
    urgent,
    prompt: urgent || acked(promptAt, start.prompt, ends.prompt),
  }
}

/** Candidate levels, most severe first, before snoozes. */
function candidates(
  i: PolicyInput,
  bad: KnownBad | undefined,
  ageMs: number,
): Level[] {
  const list: Level[] = []
  if (bad) list.push({ attention: 'urgent', reason: bad.reason })
  const { prompt, urgent } = i.escalation
  if (urgent && ageMs >= urgent.afterMs)
    list.push({ attention: 'urgent', reason: 'expired' })
  if (prompt && ageMs >= prompt.afterMs)
    list.push({ attention: 'prompt', reason: 'stale' })
  return list
}

function isMuted(level: Level, m: ReturnType<typeof mutes>): boolean {
  if (level.reason === 'rollback' || level.reason === 'forced') return m.bad
  return level.attention === 'urgent' ? m.urgent : m.prompt
}

/** While the gate is closed, a raise holds at a level that's still true. */
function hold(published: Attention): Level {
  if (published === 'prompt') return { attention: 'prompt', reason: 'stale' } // prompt only ever means stale
  return { attention: 'passive', reason: 'waiting' }
}

function deadlines(i: PolicyInput): number[] {
  const start = starts(i)
  const ends = snoozeEnds(i)
  const badUntil = i.snoozes.bad?.[i.current.version]?.until
  const server = [
    start.prompt,
    start.urgent,
    ends.prompt,
    ends.urgent,
    badUntil,
  ]
  return server
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
    .map(t => t - i.clockOffset) // to the client clock
    .filter(t => t > i.now)
}

export function decide(i: PolicyInput): Decision {
  // Same build is caught up, unless this response forces it (a rebuild with a cutoff).
  if (
    i.latest.version === i.current.version &&
    evidence(i)?.reason !== 'forced'
  ) {
    const caughtUp: Level = { attention: 'none', reason: 'caught-up' }
    return { target: caughtUp, publish: caughtUp, deadlines: [] }
  }
  const bad = detectBad(i)
  const ageMs = i.now + i.clockOffset - Date.parse(i.current.builtAt)
  const all = candidates(i, bad, ageMs)
  const m = mutes(i, bad)
  const unmuted = all.find(level => !isMuted(level, m))
  const target: Level = unmuted ?? {
    attention: 'passive',
    reason: all.length ? 'dismiss' : 'new-build',
  }

  const raise =
    rank[target.attention] > rank[i.published] &&
    rank[target.attention] >= rank.prompt
  const publish = raise && !i.gateOpen ? hold(i.published) : target
  return { target, publish, ...(bad && { bad }), deadlines: deadlines(i) }
}

/** Accept only a well-formed version.json; anything else is ignored. */
export function isVersionInfo(x: unknown): x is VersionInfo {
  return v.is(VersionInfoSchema, x)
}
