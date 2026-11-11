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

/** Run app code without letting it break the machine. */
export function isolate<A extends unknown[]>(
  label: string,
  fn: ((...args: A) => void) | undefined,
  ...args: A
) {
  try {
    fn?.(...args)
  } catch (error) {
    console.error(`[app-version] ${label} threw`, error)
  }
}

/** Base UI-style details object: a payload plus cancel() / isCanceled. */
function withCancel<T extends object>(
  base: T,
): T & { cancel: () => void; readonly isCanceled: boolean } {
  let canceled = false

  return Object.defineProperties(base, {
    cancel: { value: () => void (canceled = true) },
    isCanceled: { get: () => canceled, enumerable: true },
  }) as T & { cancel: () => void; readonly isCanceled: boolean }
}

const keyOf = (level: Level, latest: VersionInfo) =>
  `${level.attention}:${level.reason}:${latest.version}`

export function createMachine(deps: MachineDeps) {
  let state: UpdateState = { attention: 'none', reason: 'unknown' }
  let knownBad: KnownBad | undefined // sticky for this page's lifetime
  let vetoed: string | undefined // a raise the app declined; re-offered after the next check
  // Server clock − performance clock, from the last check's Date header. Anchoring to the
  // monotonic clock means the user's clock jumping can't move our idea of server time.
  let serverMinusTick: number | undefined

  const offset = () =>
    serverMinusTick === undefined
      ? 0
      : serverMinusTick + performance.now() - Date.now()

  let offering = false

  const decision = (
    latest: VersionInfo,
    ctx: Context,
    snoozes: Snoozes = deps.snoozes.get(),
  ) => {
    const d = decide({
      current: deps.current,
      latest,
      now: ctx.now,
      clockOffset: offset(),
      ...(knownBad && { knownBad }),
      snoozes,
      escalation: deps.escalation,
      published: state.attention,
      gateOpen: ctx.gateOpen,
    })

    if (d.bad) {
      knownBad = d.bad
    }
    return d
  }

  function emit(next: UpdateState) {
    if (
      next.attention === state.attention &&
      next.reason === state.reason &&
      next.latest?.version === state.latest?.version
    ) {
      return // snapshots stay identical until something real changes
    }

    state = next
    deps.notify()
  }

  const keep = (latest: VersionInfo) => emit({ ...state, latest })

  /** Ask the app. Only raises and this tab's own dismiss are cancelable; everything else is reported. */
  function offer(
    next: Level,
    latest: VersionInfo,
    source: ChangeSource,
    cancelable: boolean,
  ): boolean {
    const details = withCancel({
      ...next,
      previous: state.attention,
      latest,
      source,
      cancelable,
    })

    offering = true

    try {
      isolate(
        'onAttentionChange',
        deps.onAttentionChange,
        next.attention,
        details,
      )
    } finally {
      offering = false
    }

    return !(cancelable && details.isCanceled)
  }

  /** The app vetoed a raise: a passive tab says so truthfully (never a stuck "waiting"); others keep their level. */
  function declined(latest: VersionInfo, source: ChangeSource) {
    if (state.attention !== 'passive' || state.reason === 'declined') {
      return keep(latest)
    }
    const next = { attention: 'passive', reason: 'declined' } as const
    offer(next, latest, source, false)
    emit({ ...next, latest })
  }

  /** Facts changed (new latest, time passed, visibility, another tab): re-decide and publish. */
  function apply(latest: VersionInfo | undefined, ctx: Context) {
    if (!latest) {
      return
    }
    if (ctx.source === 'check') {
      vetoed = undefined
    } // a fresh check re-opens declined raises
    const d = decision(latest, ctx)

    // A declined target stays declined: don't publish its hold either (no stuck "waiting").
    if (
      vetoed === keyOf(d.target, latest) &&
      rank[d.target.attention] > rank[state.attention]
    ) {
      return declined(latest, ctx.source)
    }

    const next = d.publish

    if (next.attention === state.attention) {
      if (next.reason !== state.reason) {
        offer(next, latest, ctx.source, false)
      } // reported, not vetoable

      return emit({ ...next, latest })
    }

    const raising = rank[next.attention] > rank[state.attention]

    if (!offer(next, latest, ctx.source, raising)) {
      vetoed = keyOf(d.target, latest)

      return declined(latest, ctx.source)
    }

    vetoed = undefined
    emit({ ...next, latest })
  }

  /** The dismissal of the current state, recorded on the server clock. */
  function snoozeFor(
    current: Exclude<UpdateState, { attention: 'none' }>,
    now: number,
  ): Snoozes {
    const s = deps.snoozes.get()
    const server = now + offset()

    if (
      (current.reason === 'rollback' || current.reason === 'forced') &&
      knownBad
    ) {
      const entry = {
        evidence: knownBad.evidence,
        until: server + badBuildSnoozeMs(deps.escalation),
      }

      return { ...s, bad: { ...s.bad, [deps.current.version]: entry } }
    }

    return current.attention === 'urgent'
      ? { ...s, urgentAt: server }
      : { ...s, promptAt: server }
  }

  /** User intent. Decides first; effects only if attention really drops and the app agrees. */
  function dismiss(ctx: Context): boolean {
    if (offering) {
      console.warn(
        '[app-version] dismiss() inside onAttentionChange is ignored; use details.cancel()',
      )

      return false
    }

    const current = state

    if (current.attention !== 'prompt' && current.attention !== 'urgent') {
      return false
    }
    const proposed = snoozeFor(current, ctx.now)

    const next = decision(
      current.latest,
      { ...ctx, gateOpen: true },
      proposed,
    ).publish

    if (rank[next.attention] >= rank[current.attention]) {
      return false
    }
    if (!offer(next, current.latest, 'user', true)) {
      return false
    }
    deps.snoozes.write(proposed, ctx.now + offset())
    vetoed = undefined
    emit({ ...next, latest: current.latest })

    return true
  }

  /** What the scheduler needs: policy deadlines, and whether a raise is waiting on the gate. */
  function pending(ctx: Context): { deadlines: number[]; held: boolean } {
    if (!state.latest) {
      return { deadlines: [], held: false }
    }
    const d = decision(state.latest, ctx)

    return {
      deadlines: d.deadlines,
      held: d.target.attention !== d.publish.attention,
    }
  }

  return {
    getState: () => state,
    apply,
    dismiss,
    pending,
    /** Record server time (Date header) at a tick. Keeps the last estimate when missing; ignores 1 s rounding. */
    observeServerTime(serverTime: number | undefined, tick: number) {
      if (serverTime === undefined) {
        return
      }
      const next = serverTime - tick

      if (
        serverMinusTick === undefined ||
        Math.abs(next - serverMinusTick) >= OFFSET_JITTER_MS
      ) {
        serverMinusTick = next
      }
    },
    isBehind: () =>
      !!state.latest && state.latest.version !== deps.current.version,
  }
}
