// Internal. Reloads: synchronous blockers decide *whether*; the app's `reload` decides *how*.
// At most one reload is in flight: a second request joins the first.
import * as v from 'valibot'
import type { Host } from './host'
import type { ReloadDetails, ReloadFn } from './types'

/** Return true to block the reload. Must be synchronous (chunk-error reloads can't wait). */
export type ReloadBlocker = (details: ReloadDetails) => boolean

const CHUNK_RELOAD_GUARD_MS = 10_000

/** When this tab last reloaded for a chunk error; missing or garbled reads as never. */
const LastChunkReload = v.fallback(
  v.pipe(v.string(), v.transform(Number), v.finite()),
  0,
)

/** The registered blockers and the one question asked of them. */
function createBlockers() {
  const blockers = new Set<{ blocker: ReloadBlocker }>()

  return {
    add: (blocker: ReloadBlocker) => {
      const entry = { blocker }
      blockers.add(entry)

      return () => void blockers.delete(entry)
    },
    blocked(details: ReloadDetails): boolean {
      for (const { blocker } of blockers) {
        try {
          if (blocker(details)) {
            return true
          }
        } catch (error) {
          console.error('[app-version] reload blocker threw', error)

          return true // a broken blocker errs on the side of keeping the user's work
        }
      }

      return false
    },
  }
}

/** Reload the page in place, or navigate to another href. */
const reloadInPlace =
  (host: Host): ReloadFn =>
  ({ href }) => {
    if (href === host.location.href) {
      host.location.reload()
    } else {
      host.location.assign(href)
    }
  }

async function perform(
  reload: ReloadFn,
  details: ReloadDetails,
): Promise<boolean> {
  try {
    return (await reload(details)) !== false
  } catch (error) {
    console.error('[app-version] reload threw', error)

    return false
  }
}

/**
 * Whether a chunk-error reload may go ahead, recording the attempt if so. Reading or writing
 * sessionStorage can throw; with no loop guard, the answer is no.
 */
function claimChunkReload(
  host: Host,
  flag: string,
  vetoed: () => boolean,
): boolean {
  try {
    const last = v.parse(LastChunkReload, host.sessionStorage.getItem(flag))

    if (Date.now() - last < CHUNK_RELOAD_GUARD_MS) {
      return false // just reloaded: let the app see it
    }

    if (vetoed()) {
      return false
    }

    host.sessionStorage.setItem(flag, String(Date.now()))

    return true
  } catch {
    return false // no sessionStorage, no loop guard: don't risk a reload loop
  }
}

export interface ReloadsOptions {
  reload?: ReloadFn
  storageKey: string
  host: Host
}

export function createReloads({ reload, storageKey, host }: ReloadsOptions) {
  const blockers = createBlockers()
  const performReload = reload ?? reloadInPlace(host)
  let inFlight: Promise<boolean> | undefined

  /** Blockers first (synchronously), then the app's reload. Concurrent requests share one. */
  function request(details: ReloadDetails): Promise<boolean> {
    if (inFlight) {
      return inFlight
    }

    if (blockers.blocked(details)) {
      return Promise.resolve(false)
    }

    // Nothing else sets `inFlight` while one is pending, so it is always this attempt.
    const attempt = perform(performReload, details).finally(() => {
      inFlight = undefined
    })

    inFlight = attempt

    return attempt
  }

  /** `vite:preloadError`: must be handled synchronously, so blockers only, then reload in place. */
  function onChunkError(e: Event) {
    if (e.defaultPrevented) {
      return
    } // the app recovered on its own; don't reload over it

    const claimed = claimChunkReload(
      host,
      `${storageKey}:chunk-reload`,
      () =>
        !!inFlight ||
        blockers.blocked({ reason: 'chunk-error', href: host.location.href }),
    )

    if (claimed) {
      e.preventDefault()
      host.location.reload()
    }
  }

  return { request, onChunkError, addBlocker: blockers.add }
}
