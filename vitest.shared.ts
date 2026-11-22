import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import type { BrowserConfigOptions, CoverageOptions } from 'vitest/node'

export const coverage: CoverageOptions = {
  provider: 'v8',
  include: ['src/**'],
  reporter: ['text-summary', 'json', 'json-summary'],
  thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
}

export const chromium: BrowserConfigOptions = {
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: 'chromium' }],
}

export default defineConfig({
  test: {
    coverage,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          setupFiles: ['test/setup.node.ts'],
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.browser.test.ts'],
          browser: chromium,
        },
      },
    ],
  },
})
