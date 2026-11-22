import type { Refresh, RefreshOutcome } from './refresh'
import { createListeners, type Readable } from './readable'
import type { Attention, UpdateState } from './types'
import type { Updates } from './update-state'

export interface Noticeable {
  attention: Attention
  reason: string
}

export type UpdateNotice<State extends Noticeable = UpdateState> = Exclude<
  State,
  { attention: 'none' }
> & {
  readonly closable: boolean
  readonly announce: 'off' | 'polite' | 'assertive'
  refresh: () => Promise<RefreshOutcome>
  close: () => void
}

export interface UpdateNoticeParts<State extends Noticeable> {
  state: Updates<State>
  refresh: Pick<Refresh, 'run'>
}

export interface UpdateNoticeOptions {
  minAttention?: Exclude<Attention, 'none'> | undefined
}

const rank = { none: 0, passive: 1, prompt: 2, urgent: 3 }

const announce = {
  none: 'off',
  passive: 'off',
  prompt: 'polite',
  urgent: 'assertive',
} as const

const keyOf = (state: Noticeable) => `${state.attention}:${state.reason}`

function reaches<State extends Noticeable>(
  state: State,
  minAttention: Attention,
): state is Exclude<State, { attention: 'none' }> {
  return (
    state.attention !== 'none' && rank[state.attention] >= rank[minAttention]
  )
}

class NoticeStore<State extends Noticeable> {
  readonly #state: Updates<State>
  readonly #refresh: Pick<Refresh, 'run'>
  readonly #minAttention: Attention
  readonly #listeners = createListeners({
    start: () => this.#start(),
    stop: () => this.#stop(),
  })

  #shown: UpdateNotice<State> | undefined
  #closed: string | undefined
  #closing = false
  #unsubscribe: (() => void) | undefined

  constructor(parts: UpdateNoticeParts<State>, options: UpdateNoticeOptions) {
    this.#state = parts.state
    this.#refresh = parts.refresh
    this.#minAttention = options.minAttention ?? 'prompt'
  }

  #reconcile = () => {
    const current = this.#state.get()
    const wanted = reaches(current, this.#minAttention) ? current : undefined
    const key = wanted && keyOf(wanted)

    if (key !== this.#closed) {
      this.#closed = undefined
    }

    if (!wanted || this.#closed) {
      this.#shown = undefined
    } else if (!this.#shown || keyOf(this.#shown) !== key) {
      this.#shown = this.#notice(wanted)
    }
  }

  #close = (notice: UpdateNotice<State>) => {
    if (this.#shown !== notice) {
      return
    }

    this.#closing = true

    if (notice.attention === 'passive') {
      this.#closed = keyOf(notice)
    } else if (notice.attention === 'urgent') {
      this.#shown = undefined
    } else if (this.#state.dismiss()) {
      this.#closed = keyOf(this.#state.get())
    }

    this.#closing = false
    this.#reconcile()
    this.#listeners.notify()
  }

  #notice = (wanted: Exclude<State, { attention: 'none' }>) => {
    const notice: UpdateNotice<State> = {
      ...wanted,
      closable: wanted.attention !== 'urgent',
      announce: announce[wanted.attention],
      refresh: () => this.#refresh.run(),
      close: () => this.#close(notice),
    }

    Object.freeze(notice)

    return notice
  }

  #start = () => {
    this.#unsubscribe = this.#state.subscribe(() => {
      if (!this.#closing) {
        this.#reconcile()
        this.#listeners.notify()
      }
    })

    this.#reconcile()
  }

  #stop = () => {
    this.#unsubscribe?.()
    this.#closed = undefined
    this.#shown = undefined
  }

  get = () => this.#shown

  subscribe = (listener: () => void) => this.#listeners.subscribe(listener)
}

export function createUpdateNotice<State extends Noticeable>(
  parts: UpdateNoticeParts<State>,
  options: UpdateNoticeOptions = {},
): Readable<UpdateNotice<State> | undefined> {
  return new NoticeStore(parts, options)
}
