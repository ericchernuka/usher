import type { RefreshOutcome } from './refresh'
import { createListeners, type Readable } from './readable'
import type { AppUpdates, Attention, UpdateState } from './types'

type Noticeable = Exclude<UpdateState, { attention: 'none' }>

/** What an update surface is asked to show, new for every change of attention or reason */
export type UpdateNotice = Exclude<UpdateState, { attention: 'none' }> & {
  /** Whether the user may close the notice, `false` at urgent attention */
  readonly closable: boolean
  /** Politeness for a screen reader, for a library that owns its live region */
  readonly announce: 'off' | 'polite' | 'assertive'
  /** Refresh requested by the user */
  refresh: () => Promise<RefreshOutcome>
  /**
   * Close by the user, which dismisses a prompt for every tab, hides a
   * passive notice until attention or reason changes, and does nothing on
   * a notice that is no longer shown
   */
  close: () => void
}

export interface UpdateNoticeOptions {
  /** Lowest attention that shows a notice, `prompt` by default */
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

export interface NoticeStore extends Readable<UpdateNotice | undefined> {
  discard: (notice: UpdateNotice) => void
}

class Notices implements NoticeStore {
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
    this.#shown = undefined
  }

  discard = (notice: UpdateNotice) => {
    if (this.#shown === notice) {
      this.#shown = undefined
    }
  }

  get = () => this.#shown

  subscribe = (listener: () => void) => this.#listeners.subscribe(listener)
}

export function createNoticeStore(
  updates: AppUpdates,
  options: UpdateNoticeOptions,
): NoticeStore {
  return new Notices(updates, options)
}

/** Create the notice a declarative surface should show, live while subscribed */
export function createUpdateNotice(
  updates: AppUpdates,
  options: UpdateNoticeOptions = {},
): Readable<UpdateNotice | undefined> {
  return createNoticeStore(updates, options)
}
