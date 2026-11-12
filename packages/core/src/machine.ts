import type { ResolvedEscalation } from './duration'
import { decide, type KnownBad, type Snoozes } from './policy'
import type { createSnoozes } from './snoozes'
import type { UpdateState, VersionInfo } from './types'

const OFFSET_JITTER_MS = 2_000

export interface MachineDeps {
  current: VersionInfo
  escalation: ResolvedEscalation
  snoozes: ReturnType<typeof createSnoozes>
  notify: () => void
}

class Machine {
  readonly deps: MachineDeps
  state: UpdateState = { attention: 'none', reason: 'unknown' }
  knownBad: KnownBad | undefined
  serverMinusTick: number | undefined

  constructor(deps: MachineDeps) {
    this.deps = deps
  }

  offset = () =>
    this.serverMinusTick === undefined
      ? 0
      : this.serverMinusTick + performance.now() - Date.now()

  apply = (latest = this.state.latest, now = Date.now()) => {
    if (!latest) {
      return
    }

    const result = this.decision(latest, now)
    this.knownBad = result.knownBad
    this.publish(result.state)
  }

  get nextAt() {
    return this.state.latest
      ? this.decision(this.state.latest, Date.now()).nextAt
      : undefined
  }

  decision = (
    latest: VersionInfo,
    now: number,
    snoozes: Snoozes = this.deps.snoozes.get(),
  ) =>
    decide({
      current: this.deps.current,
      latest,
      now,
      clockOffset: this.offset(),
      ...(this.knownBad && { knownBad: this.knownBad }),
      snoozes,
      escalation: this.deps.escalation,
    })

  publish = (next: UpdateState) => {
    if (
      next.attention === this.state.attention &&
      next.reason === this.state.reason &&
      next.latest?.version === this.state.latest?.version
    ) {
      return
    }

    this.state = next
    this.deps.notify()
  }

  dismiss = (): boolean => {
    if (this.state.attention !== 'prompt') {
      return false
    }

    const now = Date.now()
    const proposed = { promptAt: now + this.offset() }
    const result = this.decision(this.state.latest, now, proposed)

    if (
      result.state.attention !== 'passive' ||
      result.state.reason !== 'dismiss'
    ) {
      return false
    }

    this.deps.snoozes.write(proposed)
    this.publish(result.state)

    return true
  }

  getState = () => this.state

  observeServerTime = (serverTime: number | undefined, tick: number) => {
    if (serverTime === undefined) {
      return
    }

    const next = serverTime - tick

    if (
      this.serverMinusTick === undefined ||
      Math.abs(next - this.serverMinusTick) >= OFFSET_JITTER_MS
    ) {
      this.serverMinusTick = next
    }
  }
}

export function createMachine(deps: MachineDeps) {
  return new Machine(deps)
}
