import type { AppUpdates } from './types'
import {
  createNoticeStore,
  type NoticeStore,
  type UpdateNotice,
  type UpdateNoticeOptions,
} from './update-notice'

/** The app's imperative presentation of attention, such as a toast library */
export interface UpdateSurface extends UpdateNoticeOptions {
  /**
   * Creation or replacement of the UI, called once per change of attention
   * or reason and retried on the next state change when it throws
   */
  show(notice: UpdateNotice): void
  /** Removal of the UI, safe to call when nothing is showing */
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
  readonly #notice: NoticeStore
  readonly #show: (notice: UpdateNotice) => void
  readonly #hide: () => void
  #shown: UpdateNotice | undefined
  #presented: UpdateNotice | undefined
  #syncing = false
  #again = false

  constructor(notice: NoticeStore, surface: UpdateSurface) {
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

    const presented = this.#present(wanted)
    this.#shown = wanted
    this.#presented = presented

    if (!safely('show', () => this.#show(presented))) {
      this.#forget()
      this.#notice.discard(wanted)
      safely('hide', this.#hide)
    }
  }

  #present = (source: UpdateNotice) => {
    const presented: UpdateNotice = {
      ...source,
      close: () => {
        if (this.#presented !== presented) {
          return
        }

        if (source.closable) {
          source.close()
        } else {
          this.#notice.renew(source)
          this.#sync()
        }
      },
    }

    Object.freeze(presented)

    return presented
  }

  #forget = () => {
    this.#shown = undefined
    this.#presented = undefined
  }

  #remove = () => {
    if (this.#shown) {
      this.#forget()
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

/** Drive an imperative surface from the app's updates and return the disconnect */
export function connectUpdateSurface(
  updates: AppUpdates,
  surface: UpdateSurface,
): () => void {
  return new SurfaceConnection(
    createNoticeStore(updates, surface),
    surface,
  ).connect()
}
