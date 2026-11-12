import type { Duration, Escalation, EscalationLevel } from './types'

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

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

export interface ResolvedLevel {
  afterMs: number
  snoozeMs?: number | undefined
}

export interface ResolvedEscalation {
  prompt?: ResolvedLevel
  urgent?: Pick<ResolvedLevel, 'afterMs'>
}

const DEFAULTS = {
  prompt: { after: '12h' },
  urgent: { after: '24h' },
} satisfies Required<Escalation>

function promptLevel(config: EscalationLevel | false | undefined) {
  if (config === false) {
    return undefined
  }

  const chosen = config ?? DEFAULTS.prompt
  const afterMs = ms(chosen.after, 'escalation.prompt.after')

  const snoozeMs =
    config?.snooze === undefined
      ? undefined
      : ms(config.snooze, 'escalation.prompt.snooze')

  if (snoozeMs !== undefined && snoozeMs <= 0) {
    throw new Error('[app-version] escalation.prompt.snooze must be positive')
  }

  return { afterMs, snoozeMs }
}

export function resolveEscalation(config: Escalation = {}): ResolvedEscalation {
  const prompt = promptLevel(config.prompt)

  const urgent =
    config.urgent === false
      ? undefined
      : {
          afterMs: ms(
            config.urgent?.after ?? DEFAULTS.urgent.after,
            'escalation.urgent.after',
          ),
        }

  if (prompt && urgent && urgent.afterMs <= prompt.afterMs) {
    throw new Error(
      '[app-version] escalation.urgent.after must be later than escalation.prompt.after',
    )
  }

  return { ...(prompt && { prompt }), ...(urgent && { urgent }) }
}
