import { mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared.ts'

export default mergeConfig(shared, {
  resolve: {
    alias: {
      'virtual:app-version': new URL('test/build-info.stub.ts', import.meta.url)
        .pathname,
    },
  },
})
