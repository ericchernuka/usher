/** Date headers have one-second resolution, so smaller changes are rounding, not drift. */
const HEADER_ROUNDING_MS = 2_000

/**
 * Server-corrected time. Build age and dismissals are measured against the
 * server's clock, anchored to monotonic time so a change to the user's clock
 * cannot move them. Until a server time has been observed, it is the local clock.
 */
export function createServerClock() {
  let serverMinusMonotonic: number | undefined

  return {
    now: (): number =>
      serverMinusMonotonic === undefined
        ? Date.now()
        : serverMinusMonotonic + performance.now(),

    observe(serverTime: number) {
      const next = serverTime - performance.now()

      if (
        serverMinusMonotonic === undefined ||
        Math.abs(next - serverMinusMonotonic) >= HEADER_ROUNDING_MS
      ) {
        serverMinusMonotonic = next
      }
    },
  }
}
