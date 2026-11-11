import { afterEach } from 'vitest'

/** A navigation the page tried to make, as the Navigation API reported it. */
export interface NavigationRequest {
  type: NavigationType
  url: string
}

const active = new Set<AbortController>()
afterEach(() => {
  for (const controller of active) controller.abort()
  active.clear()
})

/**
 * Records and cancels every navigation (`location.reload`, `assign`, `replace`)
 * until the test ends. A browser can't stub `window.location`, and a real
 * navigation would unload the test page.
 */
export function captureNavigations(): NavigationRequest[] {
  const requests: NavigationRequest[] = []
  const controller = new AbortController()
  active.add(controller)
  navigation.addEventListener(
    'navigate',
    event => {
      requests.push({
        type: event.navigationType,
        url: event.destination.url,
      })
      event.preventDefault()
    },
    { signal: controller.signal },
  )
  return requests
}
