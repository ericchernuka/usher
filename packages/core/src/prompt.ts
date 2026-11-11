import type { AppUpdates } from './core'
import type {
  Attention,
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

type Behind = Exclude<Attention, 'none'>

interface PromptBase {
  /** Stable id: upsert your toast/banner by it. */
  readonly id: typeof PROMPT_ID
  readonly latest: VersionInfo
  /** The user wants the update. Resolves false if a blocker or your `reload` declined. */
  refresh(): Promise<boolean>
  /**
   * The user closed the prompt. Safe to wire to any onClose/onDismiss, including ones
   * your library also fires on programmatic closes or twice: stale handles ignore it.
   * On success your `hide()` is called, so every UI closes the same way.
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
 * - re-showing when onAttentionChange cancels a dismiss
 * - keeping the store polling while connected; `disconnect()` hides and unsubscribes
 */
const keyOf = (s: UpdateState) => `${s.attention}:${s.reason}`

/** Adapter code is app code: isolate it so it can't break the store or leak this connection. */
function safely(label: string, fn: () => void) {
  try {
    fn()
    return true
  } catch (error) {
    console.error(`[app-version] connectPrompt ${label}() threw`, error)
    return false
  }
}

export function connectPrompt(
  updates: AppUpdates,
  { minAttention = 'prompt', show, hide }: PromptAdapter,
): () => void {
  // What the adapter's UI currently is. `key` = attention:reason it reflects.
  type View =
    | { kind: 'hidden' }
    | { kind: 'shown'; handle: Prompt; key: string }
    | { kind: 'closed'; key: string } // closed by the user; stays closed while the key matches
  let view: View = { kind: 'hidden' }
  let dismissing = false

  // A dismiss from inside show() must not hide() mid-show (that orphans the UI): defer it.
  let hideAfterStep = false
  function closeAfterDismiss(key: string) {
    view = { kind: 'closed', key } // set first: hide() may fire onClose → stale dismiss
    if (syncing) hideAfterStep = true
    else safely('hide', hide)
  }

  function step() {
    if (dismissing) return // closing on the dismissed state happens right after
    const state = updates.getState()
    if (
      state.attention === 'none' ||
      rank[state.attention] < rank[minAttention]
    ) {
      const wasShown = view.kind === 'shown'
      view = { kind: 'hidden' } // set first: our own hide must not read as a user dismiss
      if (wasShown) safely('hide', hide)
      return
    }
    // Re-show only when attention or reason changes; a newer `latest` alone isn't news.
    const key = keyOf(state)
    if (view.kind !== 'hidden' && view.key === key) return

    const prompt = Object.freeze({
      id: PROMPT_ID,
      attention: state.attention,
      reason: state.reason,
      latest: state.latest,
      refresh: () => updates.refresh(),
      dismiss: () => {
        if (view.kind !== 'shown' || view.handle !== prompt) return // stale handle
        if (prompt.attention === 'passive') return closeAfterDismiss(key) // nothing to snooze
        // Pause steps while the store updates, then close on whatever it actually published.
        dismissing = true
        let dismissed = false
        try {
          dismissed = updates.dismiss()
        } finally {
          dismissing = false
        }
        if (dismissed) return closeAfterDismiss(keyOf(updates.getState()))
        view = { kind: 'hidden' } // refused or not applicable: show the current state again
        sync()
      },
    }) as Prompt
    // Record it as shown only once show() succeeded; a throwing show() retries on the next change.
    const previous = view
    view = { kind: 'shown', handle: prompt, key }
    if (!safely('show', () => show(prompt)))
      view = previous.kind === 'shown' ? { kind: 'hidden' } : previous
  }

  // Re-entrancy guard: a sync triggered from inside show()/hide() runs after the current
  // step, so hide() never interleaves with show(). Capped, so a pathological adapter
  // (show() → dismiss() → app always cancels) can't spin forever.
  const MAX_PASSES = 5
  let syncing = false
  let again = false
  function sync() {
    if (syncing) {
      again = true
      return
    }
    syncing = true
    try {
      let passes = 0
      do {
        again = false
        step()
        if (hideAfterStep) {
          hideAfterStep = false
          safely('hide', hide)
        }
      } while (again && ++passes < MAX_PASSES)
      if (again)
        console.error(
          '[app-version] connectPrompt: adapter keeps re-triggering updates; stopped after',
          MAX_PASSES,
        )
      again = false
    } finally {
      syncing = false
    }
  }

  const unsubscribe = updates.subscribe(sync)
  sync()
  return () => {
    unsubscribe()
    const wasShown = view.kind === 'shown'
    view = { kind: 'hidden' }
    if (wasShown) safely('hide', hide)
  }
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
