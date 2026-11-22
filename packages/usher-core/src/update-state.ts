import { sameBuildFacts, type BuildFacts } from './build-facts'
import { resolveRunning } from './options'
import type { PromptDismissal } from './prompt-dismissal'
import { createListeners, type Readable } from './readable'
import type { Asked, Moment, Signal } from './signals'
import { insideTab, type Tab } from './tab'
import { attentionRank, type UpdateState, type Updates } from './types'
import { createVisibleTimer } from './visible-timer'

export interface UpdateStateParts {
  running: BuildFacts
  latest: Readable<BuildFacts | undefined>
  signals: ReadonlyArray<Signal>
  dismissal: PromptDismissal
}

interface Verdict {
  state: UpdateState
  nextAt: number
}

function sameState(next: UpdateState, current: UpdateState) {
  return (
    next.attention === current.attention &&
    next.reason === current.reason &&
    next.latest !== undefined &&
    current.latest !== undefined &&
    sameBuildFacts(next.latest, current.latest)
  )
}

function quietUntil(
  { dismissableFrom }: Asked,
  dismissedAt: number | undefined,
  promptSnooze: number | undefined,
) {
  if (
    dismissableFrom === undefined ||
    dismissedAt === undefined ||
    dismissedAt < dismissableFrom
  ) {
    return undefined
  }

  return promptSnooze === undefined ? Infinity : dismissedAt + promptSnooze
}

class UpdateStateStore implements Updates {
  readonly #tab: Tab
  readonly #running: BuildFacts
  readonly #latest: Readable<BuildFacts | undefined>
  readonly #dismissal: PromptDismissal
  readonly #signals: ReadonlyArray<Signal>
  readonly #deadline: ReturnType<typeof createVisibleTimer>
  readonly #listeners = createListeners({
    start: () => this.#start(),
    stop: () => this.#stop(),
  })

  #state: UpdateState = { attention: 'none', reason: 'unknown' }
  #active = false
  #stops: Array<() => void> = []

  constructor(tab: Tab, parts: UpdateStateParts) {
    this.#tab = tab
    this.#running = resolveRunning(parts.running)
    this.#latest = parts.latest
    this.#dismissal = parts.dismissal
    this.#signals = parts.signals
    this.#deadline = createVisibleTimer(insideTab(tab).env, this.#evaluate)
  }

  #asks = (moment: Moment, dismissedAt: number | undefined) =>
    this.#signals.flatMap(signal => {
      signal.observe(moment)
      const asked = signal.ask(moment)

      if (!asked) {
        return []
      }

      const until = quietUntil(asked, dismissedAt, this.#dismissal.promptSnooze)

      const state: UpdateState =
        until !== undefined && moment.now < until
          ? { attention: 'passive', reason: 'dismissed', latest: moment.latest }
          : { ...asked.claim, latest: moment.latest }

      return [{ state, changes: [asked.changesAt, until] }]
    })

  #decide = (dismissedAt = this.#dismissal.get()): Verdict | undefined => {
    const latest = this.#latest.get()

    if (!latest) {
      return undefined
    }

    const moment = { running: this.#running, latest, now: this.#tab.now() }
    const asks = this.#asks(moment, dismissedAt)

    const state = asks.reduce<UpdateState>(
      (loudest, { state: next }) =>
        attentionRank[next.attention] > attentionRank[loudest.attention]
          ? next
          : loudest,
      { attention: 'none', reason: 'caught-up', latest },
    )

    const upcoming = asks.flatMap(({ changes }) =>
      changes.flatMap(time =>
        time !== undefined && time > moment.now ? [time] : [],
      ),
    )

    return { state, nextAt: Math.min(...upcoming, Infinity) }
  }

  #apply = ({ state, nextAt }: Verdict) => {
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
      this.#dismissal.subscribe(this.#evaluate),
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
    if (this.#state.attention !== 'prompt') {
      return false
    }

    const at = this.#tab.now()
    const verdict = this.#decide(at)

    if (verdict?.state.reason !== 'dismissed') {
      return false
    }

    this.#dismissal.record(at)
    this.#apply(verdict)

    return true
  }
}

export function createUpdateState(tab: Tab, parts: UpdateStateParts): Updates {
  return new UpdateStateStore(tab, parts)
}
