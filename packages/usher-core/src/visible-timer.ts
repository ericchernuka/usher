import type { Environment } from './environment'

/** The longest delay a browser timer holds. A longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * One pending timer that only runs in a visible tab. `arm` takes a function
 * that says how long is left, and `callback` runs once nothing is left and the
 * tab is visible. Arming replaces whatever was pending.
 *
 * The timer asks how long is left each time it wakes: when its browser timer
 * fires and when the tab's visibility changes. So a hidden tab holds no browser
 * timer and catches up when it returns, a delay longer than a browser timer can
 * hold is waited out in parts, and an owner whose clock jumped is corrected at
 * the next wake.
 */
export function createVisibleTimer(
  env: Pick<Environment, 'isVisible' | 'startTimer' | 'onVisibilityChange'>,
  callback: () => void,
) {
  let disarm: (() => void) | undefined

  function cancel() {
    disarm?.()
    disarm = undefined
  }

  return {
    arm(remaining: () => number) {
      cancel()
      let cancelTimer: (() => void) | undefined

      function wait() {
        cancelTimer?.()

        cancelTimer = env.isVisible()
          ? env.startTimer(
              wake,
              Math.min(Math.max(0, remaining()), MAX_TIMER_MS),
            )
          : undefined
      }

      function wake() {
        if (env.isVisible() && remaining() <= 0) {
          cancel()
          callback()
        } else {
          wait()
        }
      }

      const stopWatching = env.onVisibilityChange(wake)

      disarm = () => {
        cancelTimer?.()
        stopWatching()
      }

      wait()
    },
    cancel,
  }
}
