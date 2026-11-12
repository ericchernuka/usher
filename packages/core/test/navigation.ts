import { afterEach } from 'vitest'

export interface NavigationRequest {
  type: NavigationType
  url: string
}

const active = new Set<AbortController>()

afterEach(() => {
  for (const controller of active) {
    controller.abort()
  }

  active.clear()
})

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
