import type { RefreshOutcome } from './refresh'
import { createListeners, type Readable } from './readable'
import type { AppUpdates, Attention, UpdateState } from './types'

type Noticeable = Exclude<UpdateState, { attention: 'none' }>

export type UpdateNotice = Exclude<UpdateState, { attention: 'none' }> & {
  readonly closable: boolean
  readonly announce: 'off' | 'polite' | 'assertive'
  refresh: () => Promise<RefreshOutcome>
  close: () => void
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

const keyOf = (state: UpdateState) => `${state.attention}:${state.reason}`

function reaches(
  state: UpdateState,
  minAttention: Attention,
): state is Noticeable {
  return (
    state.attention !== 'none' && rank[state.attention] >= rank[minAttention]
  )
}

class NoticeStore {
  readonly #state: AppUpdates['state']
  readonly #refresh: AppUpdates['refresh']
  readonly #minAttention: Attention
  readonly #listeners = createListeners({
    start: () => this.#start(),
    stop: () => this.#stop(),
  })

  #shown: UpdateNotice | undefined
  #closed: string | undefined
  #closing = false
  #unsubscribe: (() => void) | undefined

  constructor(updates: AppUpdates, options: UpdateNoticeOptions) {
    this.#state = updates.state
    this.#refresh = updates.refresh
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

  #close = (notice: UpdateNotice) => {
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

  #notice = (wanted: Noticeable) => {
    const notice: UpdateNotice = {
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

export function createUpdateNotice(
  updates: AppUpdates,
  options: UpdateNoticeOptions = {},
): Readable<UpdateNotice | undefined> {
  return new NoticeStore(updates, options)
}
