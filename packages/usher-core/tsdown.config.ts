import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  platform: 'browser',
  dts: true,
})
