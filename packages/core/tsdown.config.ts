import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    platform: 'browser',
    dts: true,
    // Supplied by the appVersion() plugin in the consuming app's build.
    deps: { neverBundle: ['virtual:app-version'] },
  },
  {
    entry: ['src/vite.ts'],
    platform: 'node',
    fixedExtension: false,
    dts: true,
  },
])
