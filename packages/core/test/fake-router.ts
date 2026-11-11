// A stand-in for an app's router, for `subscribeToNavigation`.
import type { SubscribeToNavigation } from '../src/index'

export function fakeRouter() {
  let listener: ((to?: { href: string }) => void) | undefined

  const subscribeToNavigation: SubscribeToNavigation = onNavigate => {
    listener = onNavigate

    return () => {
      listener = undefined
    }
  }

  return {
    subscribeToNavigation,
    /** The router fires before navigating (with a destination) or after (with none). */
    navigate: (to?: { href: string }) => listener?.(to),
  }
}
