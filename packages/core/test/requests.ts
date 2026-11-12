import { server } from './mocks/node'

export function recordRequests(): Request[] {
  const requests: Request[] = []
  server.events.on('request:start', ({ request }) => {
    requests.push(request)
  })

  return requests
}
