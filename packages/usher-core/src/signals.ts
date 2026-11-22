import {
  isForcedUpdate,
  isRollback,
  isSuperseded,
  supersededAt,
  type Builds,
} from './build-facts'
import { resolveEscalation, type EscalationOptions } from './options'

export interface Claim {
  attention: 'passive' | 'prompt' | 'urgent'
  reason: string
}

export interface Asked<Claimed extends Claim> {
  claim: Claimed
  since?: number | undefined
  changesAt?: number | undefined
}

export interface Moment extends Builds {
  now: number
}

export interface SignalDefinition<Memory, Claimed extends Claim> {
  initial: Memory
  observe(memory: Memory, builds: Builds): Memory
  ask(memory: Memory, moment: Moment): Asked<Claimed> | undefined
}

export interface Signal<Claimed extends Claim> {
  track(): {
    observe(builds: Builds): void
    ask(moment: Moment): Asked<Claimed> | undefined
  }
}

export function defineSignal<Memory, const Claimed extends Claim>(
  definition: SignalDefinition<Memory, Claimed>,
): Signal<Claimed> {
  return {
    track() {
      let memory = definition.initial

      return {
        observe(builds) {
          memory = definition.observe(memory, builds)
        },
        ask: moment => definition.ask(memory, moment),
      }
    },
  }
}

const after = (start: number, duration: number | undefined) =>
  duration === undefined ? undefined : start + duration

export interface EscalationClaim {
  attention: 'passive' | 'prompt' | 'urgent'
  reason: 'outdated'
}

export function escalation(
  options: EscalationOptions = {},
): Signal<EscalationClaim> {
  const { promptAfter, urgentAfter } = resolveEscalation(options)

  return defineSignal<number | undefined, EscalationClaim>({
    initial: undefined,
    observe: (outdatedSince, builds) =>
      isSuperseded(builds)
        ? (outdatedSince ?? supersededAt(builds))
        : undefined,
    ask(outdatedSince, { now }) {
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
        since: promptStart,
        changesAt: urgentStart,
      }
    },
  })
}

const sticky = <const Reason extends string>(
  reason: Reason,
  detected: (builds: Builds) => boolean,
) =>
  defineSignal({
    initial: false,
    observe: (seen: boolean, builds) => seen || detected(builds),
    ask: seen =>
      seen ? { claim: { attention: 'urgent', reason } } : undefined,
  })

export const rollback = () => sticky('rollback', isRollback)

export const forcedUpdate = () => sticky('forced', isForcedUpdate)
