import type { Readable } from './readable'
import {
  createUpdateNotice,
  type Noticeable,
  type UpdateNotice,
  type UpdateNoticeOptions,
  type UpdateNoticeParts,
} from './update-notice'
import type { UpdateState } from './types'

export interface UpdateSurface<
  State extends Noticeable = UpdateState,
> extends UpdateNoticeOptions {
  show(notice: UpdateNotice<State>): void
  hide(): void
}

function safely(label: string, fn: () => void) {
  try {
    fn()

    return true
  } catch (error) {
    console.error(`[usher] update surface ${label}() threw`, error)

    return false
  }
}

const MAX_PASSES = 5

class SurfaceConnection<State extends Noticeable> {
  readonly #notice: Readable<UpdateNotice<State> | undefined>
  readonly #show: (notice: UpdateNotice<State>) => void
  readonly #hide: () => void
  #shown: UpdateNotice<State> | undefined
  #syncing = false
  #again = false

  constructor(
    notice: Readable<UpdateNotice<State> | undefined>,
    surface: UpdateSurface<State>,
  ) {
    this.#notice = notice
    this.#show = shown => surface.show(shown)
    this.#hide = () => surface.hide()
  }

  #reconcile = () => {
    const wanted = this.#notice.get()

    if (!wanted) {
      return this.#remove()
    }

    if (this.#shown === wanted) {
      return
    }

    this.#shown = wanted

    if (!safely('show', () => this.#show(wanted))) {
      this.#shown = undefined
      safely('hide', this.#hide)
    }
  }

  #remove = () => {
    if (this.#shown) {
      this.#shown = undefined
      safely('hide', this.#hide)
    }
  }

  #sync = () => {
    if (this.#syncing) {
      this.#again = true

      return
    }

    this.#syncing = true

    try {
      let passes = 0

      do {
        this.#again = false
        this.#reconcile()
      } while (this.#again && ++passes < MAX_PASSES)

      if (this.#again) {
        console.error(
          '[usher] update surface keeps re-triggering updates; stopped after',
          MAX_PASSES,
        )
      }
    } finally {
      this.#again = false
      this.#syncing = false
    }
  }

  connect = () => {
    const unsubscribe = this.#notice.subscribe(this.#sync)
    this.#sync()

    return () => {
      unsubscribe()
      this.#remove()
    }
  }
}

export function connectUpdateSurface<State extends Noticeable>(
  updates: UpdateNoticeParts<State>,
  surface: UpdateSurface<State>,
): () => void {
  return new SurfaceConnection(
    createUpdateNotice(updates, surface),
    surface,
  ).connect()
}
