import {
  isForcedUpdate,
  isRollback,
  isSuperseded,
  supersededAt,
  type Builds,
} from './build-facts'
import { resolveEscalation, type EscalationOptions } from './options'

export type Claim =
  | { attention: 'passive' | 'prompt' | 'urgent'; reason: 'outdated' }
  | { attention: 'urgent'; reason: 'rollback' | 'forced' }

export interface Asked {
  claim: Claim
  dismissableFrom?: number
  changesAt?: number | undefined
}

export interface Moment extends Builds {
  now: number
}

export interface Signal {
  observe: (builds: Builds) => void
  ask: (moment: Moment) => Asked | undefined
}

const after = (start: number, duration: number | undefined) =>
  duration === undefined ? undefined : start + duration

export function escalation(options: EscalationOptions): Signal {
  const { promptAfter, urgentAfter } = resolveEscalation(options)
  let outdatedSince: number | undefined

  return {
    observe(builds) {
      outdatedSince = isSuperseded(builds)
        ? (outdatedSince ?? supersededAt(builds))
        : undefined
    },
    ask({ now }) {
      if (outdatedSince === undefined) {
        return undefined
      }

      const promptStart = after(outdatedSince, promptAfter)
      const urgentStart = after(outdatedSince, urgentAfter)

      if (urgentStart !== undefined && now >= urgentStart) {
        return { claim: { attention: 'urgent', reason: 'outdated' } }
      }

      if (promptStart === undefined || now < promptStart) {
        return {
          claim: { attention: 'passive', reason: 'outdated' },
          changesAt: promptStart ?? urgentStart,
        }
      }

      return {
        claim: { attention: 'prompt', reason: 'outdated' },
        dismissableFrom: promptStart,
        changesAt: urgentStart,
      }
    },
  }
}

function sticky(
  reason: 'rollback' | 'forced',
  detected: (builds: Builds) => boolean,
): Signal {
  let seen = false

  return {
    observe(builds) {
      seen ||= detected(builds)
    },
    ask: () => (seen ? { claim: { attention: 'urgent', reason } } : undefined),
  }
}

export const rollback = () => sticky('rollback', isRollback)

export const forcedUpdate = () => sticky('forced', isForcedUpdate)
