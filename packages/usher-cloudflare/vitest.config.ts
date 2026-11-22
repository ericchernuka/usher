import { defineConfig } from 'vitest/config'
import { coverage } from '../../vitest.shared.ts'

export default defineConfig({
  test: {
    coverage,
    name: 'unit',
    environment: 'node',
    include: ['test/*.test.ts'],
  },
})
