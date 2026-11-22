import type { Readable } from './readable'
import type { AppUpdates } from './types'
import {
  createUpdateNotice,
  type UpdateNotice,
  type UpdateNoticeOptions,
} from './update-notice'

export interface UpdateSurface extends UpdateNoticeOptions {
  show(notice: UpdateNotice): void
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

class SurfaceConnection {
  readonly #notice: Readable<UpdateNotice | undefined>
  readonly #show: (notice: UpdateNotice) => void
  readonly #hide: () => void
  #shown: UpdateNotice | undefined
  #syncing = false
  #again = false

  constructor(
    notice: Readable<UpdateNotice | undefined>,
    surface: UpdateSurface,
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

export function connectUpdateSurface(
  updates: AppUpdates,
  surface: UpdateSurface,
): () => void {
  return new SurfaceConnection(
    createUpdateNotice(updates, surface),
    surface,
  ).connect()
}
