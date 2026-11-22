import { defineConfig } from 'vitest/config'
import { chromium, coverage } from '../../vitest.shared.ts'

export default defineConfig({
  resolve: {
    alias: {
      'virtual:usher': new URL('test/build-info.stub.ts', import.meta.url)
        .pathname,
    },
  },
  optimizeDeps: {
    include: ['vitest-browser-react', 'vitest-browser-react/pure'],
  },
  test: {
    coverage,
    projects: [
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.tsx'],
          browser: chromium,
        },
      },
      {
        extends: true,
        test: {
          name: 'webkit',
          include: ['test/announcing.browser.test.tsx'],
          browser: { ...chromium, instances: [{ browser: 'webkit' }] },
        },
      },
    ],
  },
})
