import type { Environment } from './environment'

/** The longest delay a browser timer holds. A longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * One pending timer that only runs in a visible tab. Arming replaces whatever
 * was pending. Arming in a hidden tab leaves nothing pending, so the owner arms
 * again when the tab becomes visible.
 *
 * A delay longer than a browser timer can hold is shortened, so `callback` can
 * run early. It must check whether its work is due and arm again if not.
 */
export function createVisibleTimer(
  env: Pick<Environment, 'isVisible' | 'startTimer'>,
  callback: () => void,
) {
  let cancelPending: (() => void) | undefined

  function cancel() {
    cancelPending?.()
    cancelPending = undefined
  }

  return {
    arm(delay: number) {
      cancel()

      if (env.isVisible()) {
        cancelPending = env.startTimer(
          callback,
          Math.min(Math.max(0, delay), MAX_TIMER_MS),
        )
      }
    },
    cancel,
  }
}
