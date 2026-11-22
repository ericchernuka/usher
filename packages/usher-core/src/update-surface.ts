import type { AppUpdates, RefreshOutcome } from './app-updates'
import type { Attention, UpdateState } from './types'

const rank: Record<Attention, number> = {
  none: 0,
  passive: 1,
  prompt: 2,
  urgent: 3,
}

/**
 * What an update surface is asked to show: the update state plus the two things
 * a user can do with it. A new notice is made for every change of attention or reason.
 */
export type UpdateNotice = Exclude<UpdateState, { attention: 'none' }> & {
  /** The user wants the update. Same as the store's `refresh()`. */
  refresh(): Promise<RefreshOutcome>
  /**
   * The user closed the surface. Safe to wire to any onClose, including one your
   * library also fires on programmatic closes or twice: a notice that is no
   * longer the one shown ignores it.
   *
   * - prompt: dismisses the prompt for every tab, then `hide()` is called.
   * - passive: `hide()` is called, and the surface stays hidden until attention or reason changes.
   * - urgent: `show()` is called again with a new notice, because urgent attention
   *   cannot be closed. Render urgent notices without a close control.
   */
  close(): void
}

/** The app's presentation of attention: a toast, banner or snackbar driven by `connectUpdateSurface`. */
export interface UpdateSurface {
  /** Lowest attention that shows the surface. Default "prompt". */
  minAttention?: Exclude<Attention, 'none'>
  /**
   * Create or replace your UI. Called once per change of attention or reason, with a
   * new notice each time. If your `show()` throws, usher logs the error, calls `hide()`
   * in case your UI partly opened, and retries on the next state change.
   */
  show(notice: UpdateNotice): void
  /**
   * Remove your UI. Called when the surface should go away, including after the user
   * closes it. Also called after your `show()` throws, when your UI may not be open,
   * so make it safe to call when nothing is showing.
   */
  hide(): void
}

const keyOf = (state: UpdateState) => `${state.attention}:${state.reason}`

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
  readonly updates: AppUpdates
  readonly minAttention: Exclude<Attention, 'none'>
  readonly show: (notice: UpdateNotice) => void
  readonly hide: () => void

  constructor(updates: AppUpdates, surface: UpdateSurface) {
    this.updates = updates
    this.minAttention = surface.minAttention ?? 'prompt'
    this.show = notice => surface.show(notice)
    this.hide = () => surface.hide()
  }

  shown: UpdateNotice | undefined

  closed: string | undefined

  syncing = false

  again = false

  reconcile = () => {
    const state = this.updates.getState()

    const wanted =
      state.attention !== 'none' &&
      rank[state.attention] >= rank[this.minAttention]
        ? state
        : undefined

    const key = wanted && keyOf(wanted)

    if (key !== this.closed) {
      this.closed = undefined
    }

    if (!wanted || this.closed) {
      return this.remove()
    }

    if (this.shown && keyOf(this.shown) === key) {
      return
    }

    const notice = this.makeNotice(wanted)
    this.shown = notice

    if (!safely('show', () => this.show(notice))) {
      this.shown = undefined
      safely('hide', this.hide)
    }
  }

  remove = () => {
    if (this.shown) {
      this.shown = undefined
      safely('hide', this.hide)
    }
  }

  close = (notice: UpdateNotice) => {
    if (notice.attention === 'passive') {
      this.closed = keyOf(notice)
    } else if (notice.attention === 'urgent') {
      this.shown = undefined
    } else if (this.updates.dismiss()) {
      this.closed = keyOf(this.updates.getState())
    }
  }

  makeNotice = (
    state: Exclude<UpdateState, { attention: 'none' }>,
  ): UpdateNotice => {
    const notice: UpdateNotice = Object.freeze<UpdateNotice>({
      ...state,
      refresh: () => this.updates.refresh(),
      close: () => {
        if (this.shown === notice) {
          this.sync(() => this.close(notice))
        }
      },
    })

    return notice
  }

  sync = (change?: () => void) => {
    if (this.syncing) {
      change?.()
      this.again = true

      return
    }

    this.syncing = true

    try {
      change?.()
      let passes = 0

      do {
        this.again = false
        this.reconcile()
      } while (this.again && ++passes < MAX_PASSES)

      if (this.again) {
        console.error(
          '[usher] update surface keeps re-triggering updates; stopped after',
          MAX_PASSES,
        )
      }
    } finally {
      this.again = false
      this.syncing = false
    }
  }

  connect = () => {
    const unsubscribe = this.updates.subscribe(() => this.sync())
    this.sync()

    return () => {
      unsubscribe()
      this.closed = undefined
      this.remove()
    }
  }
}

/**
 * Drive any notification UI (toast library, snackbar, banner store) from the update
 * store. The surface maps show/hide to its library; the connection does the rest:
 * it applies the attention threshold, calls `show` once per change, tells a user's
 * close apart from its own hide, and keeps the store polling while connected.
 *
 * Returns `disconnect()`, which hides the surface and unsubscribes.
 */
export function connectUpdateSurface(
  updates: AppUpdates,
  surface: UpdateSurface,
): () => void {
  return new SurfaceConnection(updates, surface).connect()
}
