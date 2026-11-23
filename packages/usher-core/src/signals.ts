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

/**
 * A reason to refresh. `ask` runs at every evaluation, sometimes more than
 * once for the same builds, and updates what the signal remembers before
 * it claims
 */
export interface Signal {
  ask: (moment: Moment) => Asked | undefined
}

const after = (start: number, duration: number | undefined) =>
  duration === undefined ? undefined : start + duration

export function escalation(options: EscalationOptions): Signal {
  const { promptAfter, urgentAfter } = resolveEscalation(options)
  let outdatedSince: number | undefined

  return {
    ask(moment) {
      outdatedSince = isSuperseded(moment)
        ? (outdatedSince ?? supersededAt(moment))
        : undefined

      if (outdatedSince === undefined) {
        return undefined
      }

      const { now } = moment
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

export function stickyUrgency(): Signal {
  let reason: 'rollback' | 'forced' | undefined

  return {
    ask(moment) {
      if (isForcedUpdate(moment)) {
        reason = 'forced'
      } else if (isRollback(moment)) {
        reason = 'rollback'
      }

      return reason && { claim: { attention: 'urgent', reason } }
    },
  }
}
