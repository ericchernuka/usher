import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ResolvedConfig } from 'vite'
import type { SkewProtectionAdapter } from './adapter'
import { pathBase } from './dev-server'

function isInside(directory: string, file: string) {
  const path = relative(directory, file)

  return !path.startsWith('..') && !isAbsolute(path)
}

export function adapterFiles(
  adapter: SkewProtectionAdapter,
  config: ResolvedConfig,
) {
  const base = pathBase(config.base)
  const outDir = resolve(config.root, config.build.outDir)

  const files = adapter.files({
    base,
    assetsPrefix: `${base}${config.build.assetsDir}/`,
    root: config.root,
  })

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
