import { isolate, withCancel } from './callbacks'
// Internal. The update state machine: the single writer of state.
//
// Model: { published state, knownBad (sticky, with evidence), vetoed target, server clock estimate } + snoozes.
// Every input becomes `apply()` (facts changed) or `dismiss()` (user intent). Each asks the
// pure policy, offers the change to onAttentionChange when it's the app's to veto, and
// publishes one snapshot. Offers are atomic: nothing can change state while one runs.
import { badBuildSnoozeMs, type ResolvedEscalation } from './duration'
import { decide, rank, type KnownBad, type Level, type Snoozes } from './policy'
import type { createSnoozes } from './snoozes'
import type {
  Attention,
  AttentionChangeDetails,
  ChangeSource,
  UpdateState,
  VersionInfo,
} from './types'

/** Offset changes smaller than this are Date-header rounding (1 s resolution), not skew. */
const OFFSET_JITTER_MS = 2_000

export interface MachineDeps {
  current: VersionInfo
  escalation: ResolvedEscalation
  snoozes: ReturnType<typeof createSnoozes>
  onAttentionChange?: (
    attention: Attention,
    details: AttentionChangeDetails,
  ) => void
  /** Called after every published change. */
  notify: () => void
}

export interface Context {
  now: number
  gateOpen: boolean
  source: ChangeSource
}

const keyOf = (level: Level, latest: VersionInfo) =>
  `${level.attention}:${level.reason}:${latest.version}`

class Machine {
  readonly deps: MachineDeps

  constructor(deps: MachineDeps) {
    this.deps = deps
  }
  state: UpdateState = { attention: 'none', reason: 'unknown' }

  knownBad: KnownBad | undefined

  vetoed: string | undefined

  serverMinusTick: number | undefined

  offset = () =>
    this.serverMinusTick === undefined
      ? 0
      : this.serverMinusTick + performance.now() - Date.now()

  offering = false

  decision = (
    latest: VersionInfo,
    ctx: Context,
    snoozes: Snoozes = this.deps.snoozes.get(),
  ) => {
    const d = decide({
      current: this.deps.current,
      latest,
      now: ctx.now,
      clockOffset: this.offset(),
      ...(this.knownBad && { knownBad: this.knownBad }),
      snoozes,
      escalation: this.deps.escalation,
      published: this.state.attention,
      gateOpen: ctx.gateOpen,
    })

    if (d.bad) {
      this.knownBad = d.bad
    }

    return d
  }

  emit = (next: UpdateState) => {
    if (
      next.attention === this.state.attention &&
      next.reason === this.state.reason &&
      next.latest?.version === this.state.latest?.version
    ) {
      return // snapshots stay identical until something real changes
    }

    this.state = next
    this.deps.notify()
  }

  keep = (latest: VersionInfo) => this.emit({ ...this.state, latest })

  offer = (
    next: Level,
    latest: VersionInfo,
    {
      source,
      cancelable = false,
    }: { source: ChangeSource; cancelable?: boolean },
  ): boolean => {
    const details = withCancel({
      ...next,
      previous: this.state.attention,
      latest,
      source,
      cancelable,
    })

    this.offering = true

    try {
      isolate(
        'onAttentionChange',
        this.deps.onAttentionChange,
        next.attention,
        details,
      )
    } finally {
      this.offering = false
    }

    return !(cancelable && details.isCanceled)
  }

  declined = (latest: VersionInfo, source: ChangeSource) => {
    if (
      this.state.attention !== 'passive' ||
      this.state.reason === 'declined'
    ) {
      return this.keep(latest)
    }

    const next = { attention: 'passive', reason: 'declined' } as const
    this.offer(next, latest, { source: source, cancelable: false })
    this.emit({ ...next, latest })
  }

  apply = (latest: VersionInfo | undefined, ctx: Context) => {
    if (!latest) {
      return
    }

    if (ctx.source === 'check') {
      this.vetoed = undefined
    } // a fresh check re-opens declined raises

    const d = this.decision(latest, ctx)

    // A declined target stays declined: don't publish its hold either (no stuck "waiting").
    if (
      this.vetoed === keyOf(d.target, latest) &&
      rank[d.target.attention] > rank[this.state.attention]
    ) {
      return this.declined(latest, ctx.source)
    }

    const next = d.publish

    if (next.attention === this.state.attention) {
      if (next.reason !== this.state.reason) {
        this.offer(next, latest, { source: ctx.source, cancelable: false })
      } // reported, not vetoable

      return this.emit({ ...next, latest })
    }

    const raising = rank[next.attention] > rank[this.state.attention]

    if (
      !this.offer(next, latest, { source: ctx.source, cancelable: raising })
    ) {
      this.vetoed = keyOf(d.target, latest)

      return this.declined(latest, ctx.source)
    }

    this.vetoed = undefined
    this.emit({ ...next, latest })
  }

  snoozeFor = (
    current: Exclude<UpdateState, { attention: 'none' }>,
    now: number,
  ): Snoozes => {
    const s = this.deps.snoozes.get()
    const server = now + this.offset()

    if (
      (current.reason === 'rollback' || current.reason === 'forced') &&
      this.knownBad
    ) {
      const entry = {
        evidence: this.knownBad.evidence,
        until: server + badBuildSnoozeMs(this.deps.escalation),
      }

      return { ...s, bad: { ...s.bad, [this.deps.current.version]: entry } }
    }

    return current.attention === 'urgent'
      ? { ...s, urgentAt: server }
      : { ...s, promptAt: server }
  }

  dismiss = (ctx: Context): boolean => {
    if (this.offering) {
      console.warn(
        '[app-version] dismiss() inside onAttentionChange is ignored; use details.cancel()',
      )

      return false
    }

    const current = this.state

    if (current.attention !== 'prompt' && current.attention !== 'urgent') {
      return false
    }

    const proposed = this.snoozeFor(current, ctx.now)

    const next = this.decision(
      current.latest,
      { ...ctx, gateOpen: true },
      proposed,
    ).publish

    if (rank[next.attention] >= rank[current.attention]) {
      return false
    }

    if (
      !this.offer(next, current.latest, { source: 'user', cancelable: true })
    ) {
      return false
    }

    this.deps.snoozes.write(proposed, ctx.now + this.offset())
    this.vetoed = undefined
    this.emit({ ...next, latest: current.latest })

    return true
  }

  pending = (ctx: Context) => {
    if (!this.state.latest) {
      return { deadlines: [], held: false }
    }

    const d = this.decision(this.state.latest, ctx)

    return {
      deadlines: d.deadlines,
      held: d.target.attention !== d.publish.attention,
    }
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

  isBehind = () =>
    !!this.state.latest &&
    this.state.latest.version !== this.deps.current.version
}

export function createMachine(deps: MachineDeps) {
  return new Machine(deps)
}
