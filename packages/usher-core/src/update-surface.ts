import type { AppUpdates } from './app-updates'
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
  /** The user wants the update. Resolves false if a blocker or your `reload` declined. */
  refresh(): Promise<boolean>
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
   * new notice each time. If it throws, the error is logged and the next state change retries.
   */
  show(notice: UpdateNotice): void
  /** Remove your UI. Called when the surface should go away, including after the user closes it. */
  hide(): void
}

const keyOf = (s: UpdateState) => `${s.attention}:${s.reason}`

function safely(label: string, fn: () => void) {
  try {
    fn()

    return true
  } catch (error) {
    console.error(`[usher] update surface ${label}() threw`, error)

    return false
  }
}

type View =
  | { kind: 'hidden' }
  | { kind: 'shown'; notice: UpdateNotice; key: string }
  | { kind: 'closed'; key: string }

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

  view: View = { kind: 'hidden' }

  dismissing = false

  hideAfterStep = false

  syncing = false

  again = false

  markClosed = (key: string) => {
    this.view = { kind: 'closed', key }

    if (this.syncing) {
      this.hideAfterStep = true
    } else {
      safely('hide', this.hide)
    }
  }

  step = () => {
    if (this.dismissing) {
      return
    }

    const state = this.updates.getState()

    if (
      state.attention === 'none' ||
      rank[state.attention] < rank[this.minAttention]
    ) {
      const wasShown = this.view.kind === 'shown'
      this.view = { kind: 'hidden' }

      if (wasShown) {
        safely('hide', this.hide)
      }

      return
    }

    const key = keyOf(state)

    if (this.view.kind !== 'hidden' && this.view.key === key) {
      return
    }

    const notice = this.makeNotice(state, key)
    const previous = this.view
    this.view = { kind: 'shown', notice, key }

    if (!safely('show', () => this.show(notice))) {
      this.view = previous.kind === 'shown' ? { kind: 'hidden' } : previous
    }
  }

  dismissPrompt = () => {
    this.dismissing = true
    let dismissed = false

    try {
      dismissed = this.updates.dismiss()
    } finally {
      this.dismissing = false
    }

    if (dismissed) {
      return this.markClosed(keyOf(this.updates.getState()))
    }

    this.sync()
  }

  makeNotice = (
    state: Exclude<UpdateState, { attention: 'none' }>,
    key: string,
  ): UpdateNotice => {
    const notice: UpdateNotice = Object.freeze<UpdateNotice>({
      ...state,
      refresh: () => this.updates.refresh(),
      close: () => {
        if (this.view.kind !== 'shown' || this.view.notice !== notice) {
          return
        }

        if (notice.attention === 'passive') {
          return this.markClosed(key)
        }

        if (notice.attention === 'prompt') {
          return this.dismissPrompt()
        }

        // Urgent attention cannot be closed, but some UI libraries remove a
        // toast regardless, so forget the shown notice and show a new one.
        this.view = { kind: 'hidden' }
        this.sync()
      },
    })

    return notice
  }

  sync = () => {
    if (this.syncing) {
      this.again = true

      return
    }

    this.syncing = true

    try {
      let passes = 0

      do {
        this.again = false
        this.step()

        if (this.hideAfterStep) {
          this.hideAfterStep = false
          safely('hide', this.hide)
        }
      } while (this.again && ++passes < MAX_PASSES)

      if (this.again) {
        console.error(
          '[usher] update surface keeps re-triggering updates; stopped after',
          MAX_PASSES,
        )
      }

      this.again = false
    } finally {
      this.syncing = false
    }
  }

  connect = () => {
    const unsubscribe = this.updates.subscribe(this.sync)
    this.sync()

    return () => {
      unsubscribe()
      const wasShown = this.view.kind === 'shown'
      this.view = { kind: 'hidden' }

      if (wasShown) {
        safely('hide', this.hide)
      }
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
