declare var __USHER_DEVTOOLS__:
  | {
      deploy: (request?: {
        mode?: 'advance' | 'force' | 'rollback' | 'reset'
      }) => Promise<import('@rndsqr/usher-core').BuildFacts>
    }
  | undefined
