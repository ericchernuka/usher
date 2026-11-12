import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    platform: 'node',
    fixedExtension: false,
    dts: true,
  },
  {
    entry: ['src/client.ts'],
    platform: 'browser',
    dts: true,
    deps: { neverBundle: ['virtual:app-version'] },
  },
])
