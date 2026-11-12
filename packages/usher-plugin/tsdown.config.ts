import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/vite.ts'],
    platform: 'node',
    fixedExtension: false,
    dts: true,
  },
  {
    entry: ['src/client.ts'],
    platform: 'browser',
    dts: true,
    deps: { neverBundle: ['virtual:usher'] },
  },
])
