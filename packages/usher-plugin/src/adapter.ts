// The contract between the build plugin and a skew-protection adapter. It names no
// bundler, so an adapter works with any plugin entry this package gains.

/** What a skew-protection adapter needs to know about the client build. */
export interface ClientBuild {
  /** URL path of the build's base, always ending in "/". A CDN base keeps only its path. */
  readonly base: string
  /** URL path under which hashed chunks are served: base + assets directory + "/". */
  readonly assetsPrefix: string
  /** Absolute project root. */
  readonly root: string
}

export interface GeneratedFile {
  readonly fileName: string
  readonly source: string
}

/** The files a host needs. The plugin writes them; the adapter only describes them. */
export interface SkewProtectionFiles {
  /** Emitted into the client output and served publicly. `fileName` is relative to it. */
  readonly clientFiles?: ReadonlyArray<GeneratedFile>
  /**
   * Written relative to the project root, for output that must not be served.
   * The plugin fails the build if one lands inside the client output.
   */
  readonly privateFiles?: ReadonlyArray<GeneratedFile>
  /** Logged by the plugin, prefixed with the adapter name. */
  readonly warnings?: ReadonlyArray<string>
}

/**
 * A host-specific way to keep old chunks reachable after a deploy. Provider
 * packages export factories that return one, e.g. `cloudflarePages()`; pass it
 * to `usher({ adapter })`.
 */
export interface SkewProtectionAdapter {
  /** Provider and target, e.g. "cloudflare-pages". Prefixes log and error messages. */
  readonly name: string
  /** Describe the files this host needs. Writes nothing and logs nothing. */
  files(build: ClientBuild): SkewProtectionFiles
}
