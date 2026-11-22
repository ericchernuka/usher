import { sameBuildFacts, type BuildFacts } from './build-facts'
import { resolveRunning } from './options'
import type { PromptDismissal } from './prompt-dismissal'
import { createListeners, type Readable } from './readable'
import type { Asked, Claim, Moment, Signal } from './signals'
import { insideTab, type Tab } from './tab'
import { createVisibleTimer } from './visible-timer'

export type UpdateStateOf<Claimed extends Claim> =
  | { attention: 'none'; reason: 'unknown'; latest?: undefined }
  | { attention: 'none'; reason: 'caught-up'; latest: BuildFacts }
  | { attention: 'passive'; reason: 'dismissed'; latest: BuildFacts }
  | (Claimed & { latest: BuildFacts })

export interface Updates<State> extends Readable<State> {
  dismiss: () => boolean
}

export interface UpdateStateParts<Signals> {
  running: BuildFacts
  latest: Readable<BuildFacts | undefined>
  signals: Signals
  dismissal?: PromptDismissal
}

interface Verdict<Claimed extends Claim> {
  state: UpdateStateOf<Claimed>
  nextAt: number
}

const rank = { none: 0, passive: 1, prompt: 2, urgent: 3 }

function sameState<Claimed extends Claim>(
  next: UpdateStateOf<Claimed>,
  current: UpdateStateOf<Claimed>,
) {
  return (
    next.attention === current.attention &&
    next.reason === current.reason &&
    next.latest !== undefined &&
    current.latest !== undefined &&
    sameBuildFacts(next.latest, current.latest)
  )
}

function quietUntil(
  asked: Asked<Claim>,
  dismissal: PromptDismissal | undefined,
  dismissedAt: number | undefined,
) {
  if (
    asked.claim.attention !== 'prompt' ||
    asked.since === undefined ||
    dismissedAt === undefined ||
    dismissedAt < asked.since
  ) {
    return undefined
  }

  return dismissal?.promptSnooze === undefined
    ? Infinity
    : dismissedAt + dismissal.promptSnooze
}

class UpdateState<Claimed extends Claim> implements Updates<
  UpdateStateOf<Claimed>
> {
  readonly #tab: Tab
  readonly #running: BuildFacts
  readonly #latest: Readable<BuildFacts | undefined>
  readonly #dismissal: PromptDismissal | undefined
  readonly #trackers: Array<ReturnType<Signal<Claimed>['track']>>
  readonly #deadline: ReturnType<typeof createVisibleTimer>
  readonly #listeners = createListeners({
    start: () => this.#start(),
    stop: () => this.#stop(),
  })
  #state: UpdateStateOf<Claimed> = { attention: 'none', reason: 'unknown' }
  #active = false
  #stops: Array<() => void> = []

  constructor(
    tab: Tab,
    parts: UpdateStateParts<ReadonlyArray<Signal<Claimed>>>,
  ) {
    this.#tab = tab
    this.#running = resolveRunning(parts.running)
    this.#latest = parts.latest
    this.#dismissal = parts.dismissal
    this.#trackers = parts.signals.map(signal => signal.track())
    this.#deadline = createVisibleTimer(insideTab(tab).env, this.#evaluate)
  }

  #asks = (moment: Moment, dismissedAt: number | undefined) =>
    this.#trackers.flatMap(tracker => {
      tracker.observe(moment)
      const asked = tracker.ask(moment)

      if (!asked) {
        return []
      }

      const until = quietUntil(asked, this.#dismissal, dismissedAt)

      const state: UpdateStateOf<Claimed> =
        until !== undefined && moment.now < until
          ? { attention: 'passive', reason: 'dismissed', latest: moment.latest }
          : { ...asked.claim, latest: moment.latest }

      return [{ state, changes: [asked.changesAt, until] }]
    })

  #decide = (
    dismissedAt = this.#dismissal?.get(),
  ): Verdict<Claimed> | undefined => {
    const latest = this.#latest.get()

    if (!latest) {
      return undefined
    }

    const moment = { running: this.#running, latest, now: this.#tab.now() }
    const asks = this.#asks(moment, dismissedAt)

    const state = asks.reduce<UpdateStateOf<Claimed>>(
      (loudest, { state: next }) =>
        rank[next.attention] > rank[loudest.attention] ? next : loudest,
      { attention: 'none', reason: 'caught-up', latest },
    )

    const upcoming = asks.flatMap(({ changes }) =>
      changes.flatMap(time =>
        time !== undefined && time > moment.now ? [time] : [],
      ),
    )

    return { state, nextAt: Math.min(...upcoming, Infinity) }
  }

  #apply = ({ state, nextAt }: Verdict<Claimed>) => {
    if (this.#active) {
      if (nextAt === Infinity) {
        this.#deadline.cancel()
      } else {
        this.#deadline.arm(() => nextAt - this.#tab.now())
      }
    }

    if (!sameState(state, this.#state)) {
      this.#state = state
      this.#listeners.notify()
    }
  }

  #evaluate = () => {
    const verdict = this.#decide()

    if (verdict) {
      this.#apply(verdict)
    }
  }

  #start = () => {
    this.#active = true

    this.#stops = [
      insideTab(this.#tab).env.onVisibilityChange(this.#evaluate),
      ...(this.#dismissal ? [this.#dismissal.subscribe(this.#evaluate)] : []),
      this.#latest.subscribe(this.#evaluate),
    ]

    this.#evaluate()
  }

  #stop = () => {
    this.#active = false
    this.#deadline.cancel()
    this.#stops.splice(0).forEach(stop => stop())
  }

  get = () => this.#state

  subscribe = (listener: () => void) => this.#listeners.subscribe(listener)

  dismiss = (): boolean => {
    const dismissal = this.#dismissal

    if (!dismissal || this.#state.attention !== 'prompt') {
      return false
    }

    const at = this.#tab.now()
    const verdict = this.#decide(at)

    if (verdict?.state.reason !== 'dismissed') {
      return false
    }

    dismissal.record(at)
    this.#apply(verdict)

    return true
  }
}

export function createUpdateState<const Claims extends ReadonlyArray<Claim>>(
  tab: Tab,
  parts: UpdateStateParts<{
    readonly [Index in keyof Claims]: Signal<Claims[Index]>
  }>,
): Updates<UpdateStateOf<Claims[number]>> {
  return new UpdateState<Claims[number]>(tab, parts)
}
