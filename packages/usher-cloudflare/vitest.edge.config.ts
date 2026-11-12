import {
  buildPagesASSETSBinding,
  cloudflareTest,
} from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { buildEdgeFixture } from './test/edge/fixture.ts'

const pages = await buildEdgeFixture('pages')
const workers = await buildEdgeFixture('workers')
const composed = await buildEdgeFixture('composed')
const compatibilityDate = '2026-11-01'

type Fixture = Awaited<ReturnType<typeof buildEdgeFixture>>

/** Workers static assets with SPA fallback, in front of the given worker. */
const workersProject = (fixture: Fixture) =>
  cloudflareTest({
    main: fixture.worker,
    miniflare: {
      compatibilityDate,
      r2Buckets: ['CHUNK_ARCHIVE'],
      assets: {
        directory: fixture.dist,
        binding: 'ASSETS',
        assetConfig: { not_found_handling: 'single-page-application' },
      },
      bindings: { CURRENT_ASSET: fixture.currentAsset },
    },
  })

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            main: pages.worker,
            miniflare: {
              compatibilityDate,
              r2Buckets: ['CHUNK_ARCHIVE'],
              serviceBindings: {
                ASSETS: await buildPagesASSETSBinding(pages.dist),
              },
              bindings: { CURRENT_ASSET: pages.currentAsset },
            },
          })),
        ],
        test: { name: 'edge-pages', include: ['test/edge/skew.test.ts'] },
      },
      {
        plugins: [workersProject(workers)],
        test: { name: 'edge-workers', include: ['test/edge/skew.test.ts'] },
      },
      {
        plugins: [workersProject(composed)],
        test: { name: 'edge-composed', include: ['test/edge/*.test.ts'] },
      },
    ],
  },
})
