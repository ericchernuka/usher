import {
  buildPagesASSETSBinding,
  cloudflareTest,
} from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { buildEdgeFixture } from './test/edge/fixture.ts'

const pages = await buildEdgeFixture('pages')
const workers = await buildEdgeFixture('workers')
const compatibilityDate = '2026-11-01'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            main: pages.worker,
            miniflare: {
              compatibilityDate,
              r2Buckets: ['BUILD_CACHE'],
              serviceBindings: {
                ASSETS: await buildPagesASSETSBinding(pages.dist),
              },
              bindings: { CURRENT_ASSET: pages.currentAsset },
            },
          })),
        ],
        test: { name: 'edge-pages', include: ['test/edge/*.test.ts'] },
      },
      {
        plugins: [
          cloudflareTest({
            main: workers.worker,
            miniflare: {
              compatibilityDate,
              r2Buckets: ['BUILD_CACHE'],
              assets: {
                directory: workers.dist,
                binding: 'ASSETS',
                assetConfig: { not_found_handling: 'single-page-application' },
              },
              bindings: { CURRENT_ASSET: workers.currentAsset },
            },
          }),
        ],
        test: { name: 'edge-workers', include: ['test/edge/*.test.ts'] },
      },
    ],
  },
})
