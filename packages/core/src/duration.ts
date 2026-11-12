// Internal. Typed durations ("30s", "5m", "12h", "2d") and escalation config resolution.
import type { Duration, Escalation, EscalationLevel } from './types'

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** Parse a Duration; throws a clear error for anything else (the type can't stop runtime strings). */
export function ms(value: Duration, label: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value)

  if (!match) {
    throw new Error(
      `[app-version] ${label}: "${value}" is not a duration like "30s", "5m", "12h" or "2d"`,
    )
  }

  const unit = match[2]

  if (unit !== 's' && unit !== 'm' && unit !== 'h' && unit !== 'd') {
    throw new Error(`[app-version] invalid duration unit: ${unit}`)
  }

  return Number(match[1]) * UNIT_MS[unit]
}

/** A level resolved to milliseconds. `snoozeMs` undefined means "until the next level". */
export interface ResolvedLevel {
  afterMs: number
  snoozeMs?: number | undefined
}

export interface ResolvedEscalation {
  prompt?: ResolvedLevel
  urgent?: ResolvedLevel & { snoozeMs: number }
}

const DEFAULTS = {
  prompt: { after: '12h' }, // Vercel Pro default skew-protection max age
  urgent: { after: '24h', snooze: '30m' }, // Vercel Enterprise default max age
} satisfies Required<Escalation>

const URGENT_SNOOZE_DEFAULT: Duration = '30m'

function level(
  config: EscalationLevel | false | undefined,
  fallback: EscalationLevel,
  name: string,
) {
  if (config === false) {
    return undefined
  }

  const chosen = config ?? fallback
  const afterMs = ms(chosen.after, `escalation.${name}.after`)

  const snoozeMs =
    chosen.snooze === undefined
      ? undefined
      : ms(chosen.snooze, `escalation.${name}.snooze`)

  if (snoozeMs !== undefined && snoozeMs <= 0) {
    throw new Error(`[app-version] escalation.${name}.snooze must be positive`)
  }

  return { afterMs, snoozeMs }
}

/** Resolve and validate. Urgent must start after prompt; both may be turned off with `false`. */
export function resolveEscalation(config: Escalation = {}): ResolvedEscalation {
  const prompt = level(config.prompt, DEFAULTS.prompt, 'prompt')
  const urgentLevel = level(config.urgent, DEFAULTS.urgent, 'urgent')

  const urgent = urgentLevel && {
    afterMs: urgentLevel.afterMs,
    snoozeMs:
      urgentLevel.snoozeMs ??
      ms(URGENT_SNOOZE_DEFAULT, 'default urgent snooze'),
  }

  if (prompt && urgent && urgent.afterMs <= prompt.afterMs) {
    throw new Error(
      '[app-version] escalation.urgent.after must be later than escalation.prompt.after',
    )
  }

  return { ...(prompt && { prompt }), ...(urgent && { urgent }) }
}

/** Snooze used for known-bad builds (rollback, forced), which are urgent regardless of escalation. */
export function badBuildSnoozeMs(escalation: ResolvedEscalation): number {
  return (
    escalation.urgent?.snoozeMs ??
    ms(URGENT_SNOOZE_DEFAULT, 'default urgent snooze')
  )
}
