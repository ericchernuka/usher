import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { GeneratedFile, SkewProtectionAdapter } from './adapter'
import type { BuildLayout } from './build-layout'

function isInside(directory: string, file: string) {
  const path = relative(directory, file)

  const leaves = path === '..' || path.startsWith(`..${sep}`)

  return !leaves && !isAbsolute(path)
}

/** Where a client build lands. It names no bundler. */
export interface ClientOutput {
  readonly layout: BuildLayout
  /** Absolute project root. */
  readonly root: string
  /** The client output directory, absolute or relative to `root`. */
  readonly outDir: string
}

export interface AdapterFilePlan {
  /** To emit into the client output. */
  readonly clientFiles: ReadonlyArray<GeneratedFile>
  /** To write at `path`, which is always outside the client output. */
  readonly privateFiles: ReadonlyArray<GeneratedFile & { path: string }>
  /** To log, already prefixed with the adapter name. */
  readonly warnings: ReadonlyArray<string>
}

/**
 * Asks the adapter for its files and decides where each one goes. Throws when
 * the adapter cannot work for this build: a relative base, or a private file
 * that would be served.
 */
export function planAdapterFiles(
  adapter: SkewProtectionAdapter,
  output: ClientOutput,
): AdapterFilePlan {
  const fail = (problem: string): never => {
    throw new Error(`[usher] ${adapter.name}: ${problem}`)
  }

  const paths =
    output.layout.paths ??
    fail(
      'the base is relative, so chunks have no fixed URL path and asset fallback cannot route them. Use an absolute base such as "/", or a CDN URL.',
    )

  const files = adapter.files({ ...paths, root: output.root })
  const outDir = resolve(output.root, output.outDir)

  const privateFiles = (files.privateFiles ?? []).map(file => ({
    fileName: file.fileName,
    source: file.source,
    path: resolve(output.root, file.fileName),
  }))

  const exposed = privateFiles.find(file => isInside(outDir, file.path))

  if (exposed) {
    fail(
      `"${exposed.fileName}" must be outside outDir, or it is served as a public asset.`,
    )
  }

  return {
    clientFiles: files.clientFiles ?? [],
    privateFiles,
    warnings: (files.warnings ?? []).map(
      warning => `[usher] ${adapter.name}: ${warning}`,
    ),
  }
}

export function writePrivateFiles(files: AdapterFilePlan['privateFiles']) {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true })
    writeFileSync(file.path, file.source)
  }
}
