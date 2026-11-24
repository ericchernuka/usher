import { createAppUpdates } from '@ericchernuka/usher-plugin/client'

export const appUpdates = createAppUpdates({
  pollInterval: 10_000,
  promptAfter: 30_000,
  urgentAfter: 60_000,
})
