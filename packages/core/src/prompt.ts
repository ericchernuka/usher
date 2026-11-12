import type { AppUpdates } from './core'
import type {
  Attention,
  Behind,
  ReasonsByAttention,
  UpdateState,
  VersionInfo,
} from './types'

const rank: Record<Attention, number> = {
  none: 0,
  passive: 1,
  prompt: 2,
  urgent: 3,
}

export const PROMPT_ID = 'app-update'

export interface PromptBase {
  /** Stable id: upsert your toast/banner by it. */
  readonly id: typeof PROMPT_ID
  readonly latest: VersionInfo
  /** The user wants the update. Resolves false if a blocker or your `reload` declined. */
  refresh(): Promise<boolean>
  /**
   * The user closed the prompt. Safe to wire to any onClose/onDismiss, including ones
   * your library also fires on programmatic closes or twice: stale handles ignore it.
   * Urgent handles cannot be dismissed. On success your `hide()` is called.
   */
  dismiss(): void
}

/** What an adapter renders: a union, so `reason` always belongs to `attention`. A new handle per change. */
export type Prompt = {
  [A in Behind]: PromptBase & {
    readonly attention: A
    readonly reason: ReasonsByAttention[A]
  }
}[Behind]

export interface PromptAdapter {
  /** Lowest attention that shows the prompt. Default "prompt". */
  minAttention?: Behind
  /** Create or update your UI. Called once per attention/reason change, always with id "app-update". */
  show(prompt: Prompt): void
  /** Remove your UI. Called when the prompt should go away, including after a user dismiss. */
  hide(): void
}

/**
 * Drive any notification UI (toast library, snackbar, banner store) from the update
 * store. The adapter maps show/hide to its library; everything else lives here:
 *
 * - threshold crossing and once-per-change `show` calls with a stable id
 * - telling a user's close apart from our own hide (stale handles are no-ops)
 * - keeping the store polling while connected; `disconnect()` hides and unsubscribes
 */
const keyOf = (s: UpdateState) => `${s.attention}:${s.reason}`

function safely(label: string, fn: () => void) {
  try {
    fn()

    return true
  } catch (error) {
    console.error(`[app-version] connectPrompt ${label}() threw`, error)

    return false
  }
}

type View =
  | { kind: 'hidden' }
  | { kind: 'shown'; handle: Prompt; key: string }
  | { kind: 'closed'; key: string }

class PromptConnection {
  readonly updates: AppUpdates
  readonly minAttention: Behind
  readonly show: (prompt: Prompt) => void
  readonly hide: () => void
  constructor(updates: AppUpdates, adapter: PromptAdapter) {
    this.updates = updates
    this.minAttention = adapter.minAttention ?? 'prompt'
    this.show = prompt => adapter.show(prompt)
    this.hide = () => adapter.hide()
  }
  view: View = { kind: 'hidden' }

  dismissing = false

  hideAfterStep = false

  closeAfterDismiss = (key: string) => {
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

    const prompt = this.makePrompt(state, key)

    const previous = this.view
    this.view = { kind: 'shown', handle: prompt, key }

    if (!safely('show', () => this.show(prompt))) {
      this.view = previous.kind === 'shown' ? { kind: 'hidden' } : previous
    }
  }

  makePrompt = (
    state: Exclude<UpdateState, { attention: 'none' }>,
    key: string,
  ): Prompt => {
    const prompt: Prompt = Object.freeze({
      ...state,
      id: PROMPT_ID,

      refresh: () => this.updates.refresh(),
      dismiss: () => {
        if (this.view.kind !== 'shown' || this.view.handle !== prompt) {
          return
        }

        if (prompt.attention === 'urgent') {
          return
        }

        if (prompt.attention === 'passive') {
          return this.closeAfterDismiss(key)
        }

        this.dismissing = true
        let dismissed = false

        try {
          dismissed = this.updates.dismiss()
        } finally {
          this.dismissing = false
        }

        if (dismissed) {
          return this.closeAfterDismiss(keyOf(this.updates.getState()))
        }

        this.sync()
      },
    })

    return prompt
  }

  MAX_PASSES = 5

  syncing = false

  again = false

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
      } while (this.again && ++passes < this.MAX_PASSES)

      if (this.again) {
        console.error(
          '[app-version] connectPrompt: adapter keeps re-triggering updates; stopped after',
          this.MAX_PASSES,
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

export function connectPrompt(
  updates: AppUpdates,
  adapter: PromptAdapter,
): () => void {
  return new PromptConnection(updates, adapter).connect()
}

export interface PromptCopy {
  title: string
  description: string
  action: string
}

/** Suggested wording by reason; adapters are free to ignore it. */
export function defaultCopy({
  attention,
  reason,
}: Pick<Prompt, 'attention' | 'reason'>): PromptCopy {
  if (reason === 'rollback' || reason === 'forced') {
    return {
      title: 'Please refresh',
      description: 'This version has a known issue. Refresh to get the fix.',
      action: 'Refresh now',
    }
  }

  if (attention === 'urgent') {
    return {
      title: 'Please refresh',
      description: "You're on an old version of the app. Refresh to update.",
      action: 'Refresh now',
    }
  }

  return {
    title: 'A new version is available',
    description: "Refresh when you're ready.",
    action: 'Refresh',
  }
}
