import type { BuildFacts } from '@rndsqr/usher-core'

declare global {
  var __USHER_DEVTOOLS__:
    | {
        deploy: (request?: {
          mode?: 'advance' | 'force' | 'rollback' | 'reset'
        }) => Promise<BuildFacts>
      }
    | undefined
}

export const devtools = globalThis.__USHER_DEVTOOLS__
