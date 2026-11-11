import { server } from './mocks/node'

/** Every request the page makes from now on (setup removes the listener after each test). */
export function recordRequests(): Request[] {
  const requests: Request[] = []
  server.events.on('request:start', ({ request }) => {
    requests.push(request)
  })

  return requests
}
