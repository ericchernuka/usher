import type { Logger } from 'vite'

/** What the `appVersion()` plugin knows about the client build, handed to a skew-protection adapter. */
export interface SkewProtectionContext {
  /** URL path of Vite's `base`, always ending in "/" (a CDN base keeps only its path). */
  readonly base: string
  /** Vite's `build.assetsDir`, where hashed chunks live. */
  readonly assetsDir: string
  /** Absolute Vite root. */
  readonly root: string
  /** Absolute client outDir. */
  readonly outDir: string
  readonly logger: Logger
  /** Fail the build with this message. */
  readonly error: (message: string) => never
}

/** A file emitted into the client bundle, `fileName` relative to outDir. */
export interface SkewProtectionAsset {
  readonly fileName: string
  readonly source: string
}

/**
 * A host-specific way to keep old chunks reachable after a deploy. Provider packages
 * export factories that return one, e.g. `cloudflarePages()`; pass it to
 * `appVersion({ skewProtection })`.
 */
export interface SkewProtectionAdapter {
  /** Files to add to the client bundle. */
  bundleAssets?(
    context: SkewProtectionContext,
  ): ReadonlyArray<SkewProtectionAsset>
  /** Runs after the client bundle is written, for output that must live outside outDir. */
  writeBundle?(context: SkewProtectionContext): void
}
