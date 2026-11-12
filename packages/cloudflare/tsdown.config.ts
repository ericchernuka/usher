import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  fixedExtension: false,
  dts: true,
  copy: ['src/edge-handler.mjs'],
})
