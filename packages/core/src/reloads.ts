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

export function createReloads(options: {
  reload?: ReloadFn
  storageKey: string
  host: Host
}) {
  const { host } = options
  const defaultReload: ReloadFn = ({ href }) => {
    if (href === host.location.href) host.location.reload()
    else host.location.assign(href)
  }

  const blockers = new Set<{ blocker: ReloadBlocker }>()
  let inFlight: Promise<boolean> | undefined

  function blocked(details: ReloadDetails): boolean {
    for (const { blocker } of blockers) {
      try {
        if (blocker(details)) return true
      } catch (error) {
        console.error('[app-version] reload blocker threw', error)
        return true // a broken blocker errs on the side of keeping the user's work
      }
    }
    return false
  }

  async function perform(details: ReloadDetails): Promise<boolean> {
    try {
      return (await (options.reload ?? defaultReload)(details)) !== false
    } catch (error) {
      console.error('[app-version] reload threw', error)
      return false
    }
  }

  /** Blockers first (synchronously), then the app's reload. Concurrent requests share one. */
  function request(details: ReloadDetails): Promise<boolean> {
    if (inFlight) return inFlight
    if (blocked(details)) return Promise.resolve(false)
    // Nothing else sets `inFlight` while one is pending, so it is always this attempt.
    const attempt = perform(details).finally(() => {
      inFlight = undefined
    })
    inFlight = attempt
    return attempt
  }

  /** `vite:preloadError`: must be handled synchronously, so blockers only, then reload in place. */
  function onChunkError(e: Event) {
    if (e.defaultPrevented) return // the app recovered on its own; don't reload over it
    const flag = `${options.storageKey}:chunk-reload`
    try {
      const last = v.parse(LastChunkReload, host.sessionStorage.getItem(flag))

      if (Date.now() - last < CHUNK_RELOAD_GUARD_MS) {
        return // just reloaded: let the app see it
      }
      if (
        inFlight ||
        blocked({ reason: 'chunk-error', href: host.location.href })
      )
        return
      host.sessionStorage.setItem(flag, String(Date.now()))
    } catch {
      return // no sessionStorage, no loop guard: don't risk a reload loop
    }
    e.preventDefault()
    host.location.reload()
  }

  return {
    request,
    onChunkError,
    addBlocker(blocker: ReloadBlocker) {
      const entry = { blocker }
      blockers.add(entry)
      return () => void blockers.delete(entry)
    },
  }
}
