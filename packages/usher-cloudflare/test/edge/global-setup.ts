import type { TestProject } from 'vitest/node'
import { buildEdgeFixture, type EdgeFixture } from './fixture.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    edgeFixtures: Record<'pages' | 'workers' | 'composed', EdgeFixture>
  }
}

// Vitest evaluates the config module several times per run, so the fixtures
// are built here, once, before any project's pool starts.
export default async function setup(project: TestProject) {
  project.provide('edgeFixtures', {
    pages: await buildEdgeFixture('pages'),
    workers: await buildEdgeFixture('workers'),
    composed: await buildEdgeFixture('composed'),
  })
}
