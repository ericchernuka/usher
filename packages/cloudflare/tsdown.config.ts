import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  fixedExtension: false,
  dts: true,
  // The adapter reads the handler as text and inlines it into the emitted worker.
  copy: ['src/edge-handler.mjs'],
})
