import {
  buildPagesASSETSBinding,
  cloudflareTest,
} from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const compatibilityDate = '2026-11-01'

// The fixtures only exist once globalSetup has built them, so each project
// reads its fixture through `inject` when its pool starts.
const workersProject = (target: 'workers' | 'composed') =>
  cloudflareTest(({ inject }) => {
    const fixture = inject('edgeFixtures')[target]

    return {
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
    }
  })

export default defineConfig({
  test: {
    globalSetup: ['test/edge/global-setup.ts'],
    projects: [
      {
        plugins: [
          cloudflareTest(async ({ inject }) => {
            const { pages } = inject('edgeFixtures')

            return {
              main: pages.worker,
              miniflare: {
                compatibilityDate,
                r2Buckets: ['CHUNK_ARCHIVE'],
                serviceBindings: {
                  ASSETS: await buildPagesASSETSBinding(pages.dist),
                },
                bindings: { CURRENT_ASSET: pages.currentAsset },
              },
            }
          }),
        ],
        test: { name: 'edge-pages', include: ['test/edge/skew.test.ts'] },
      },
      {
        plugins: [workersProject('workers')],
        test: { name: 'edge-workers', include: ['test/edge/skew.test.ts'] },
      },
      {
        plugins: [workersProject('composed')],
        test: { name: 'edge-composed', include: ['test/edge/*.test.ts'] },
      },
    ],
  },
})
