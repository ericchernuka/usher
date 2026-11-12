import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    platform: 'node',
    fixedExtension: false,
    dts: true,
  },
  {
    entry: ['src/worker.ts'],
    platform: 'neutral',
    fixedExtension: false,
    dts: true,
  },
])
