import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'virtual:app-version': new URL('test/build-info.stub.ts', import.meta.url)
        .pathname,
    },
  },
  optimizeDeps: {
    include: [
      'vitest-browser-react',
      'vitest-browser-react/pure',
      '@base-ui/react/toast',
    ],
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'json', 'json-summary'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.tsx'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
