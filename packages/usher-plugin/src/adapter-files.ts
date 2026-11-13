import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ResolvedConfig } from 'vite'
import type { SkewProtectionAdapter } from './adapter'
import type { BuildLayout } from './build-layout'

function isInside(directory: string, file: string) {
  const path = relative(directory, file)

  return !path.startsWith('..') && !isAbsolute(path)
}

export function adapterFiles(
  adapter: SkewProtectionAdapter,
  config: ResolvedConfig,
  layout: BuildLayout,
) {
  if (!layout.paths) {
    return {
      clientFiles: [],
      privateFiles: [],
      warnings: [],
      error: `[usher] ${adapter.name}: base "${config.base}" is relative, so chunks have no fixed URL path and asset fallback cannot route them. Use an absolute base such as "/", or a CDN URL.`,
    }
  }

  const outDir = resolve(config.root, config.build.outDir)
  const files = adapter.files({ ...layout.paths, root: config.root })

  const privateFiles = (files.privateFiles ?? []).map(file => ({
    fileName: file.fileName,
    source: file.source,
    path: resolve(config.root, file.fileName),
  }))

  const exposed = privateFiles.find(file => isInside(outDir, file.path))

  return {
    clientFiles: files.clientFiles ?? [],
    privateFiles,
    warnings: (files.warnings ?? []).map(
      warning => `[usher] ${adapter.name}: ${warning}`,
    ),
    error:
      exposed &&
      `[usher] ${adapter.name}: "${exposed.fileName}" must be outside outDir, or it is served as a public asset.`,
  }
}

export function writePrivateFiles(
  files: ReadonlyArray<{ path: string; source: string }>,
) {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.source)
  }
}
