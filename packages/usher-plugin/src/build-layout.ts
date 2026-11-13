// The build layout: the URL paths a build is served under. Every path the
// plugin emits, serves or hands to an adapter comes from the bundler's resolved
// base through here. It names no bundler.

/** A base without a URL path of its own. Its paths depend on the page URL. */
const isRelative = (base: string) =>
  !base.startsWith('/') && !URL.canParse(base)

export interface BuildLayout {
  /** The URL a tab fetches the version file from. Relative when the base is. */
  readonly versionUrl: string
  /** Fixed URL paths, each ending in "/". Undefined when the base is relative. */
  readonly paths:
    | {
        /** URL path of the base. A CDN base keeps only its path. */
        readonly base: string
        /** URL path under which hashed chunks are served. */
        readonly assetsPrefix: string
      }
    | undefined
}

export function buildLayout(build: {
  /** As the bundler resolved it: an absolute path, a full URL, or relative. */
  base: string
  assetsDir: string
  fileName: string
}): BuildLayout {
  const versionUrl = build.base + build.fileName

  if (isRelative(build.base)) {
    return { versionUrl, paths: undefined }
  }

  const base = new URL(build.base, 'https://app.invalid').pathname

  return {
    versionUrl,
    paths: { base, assetsPrefix: `${base}${build.assetsDir}/` },
  }
}
