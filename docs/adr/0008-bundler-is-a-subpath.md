# The bundler is a subpath, with no bundler abstraction

## Context

Only Vite is supported, and another bundler may be wanted later. The usual ways to prepare for that are a package per bundler, or one plugin written against unplugin so that it runs in several.

Most of the package does not depend on a bundler. Resolving build facts, the `virtual:usher` module id, the browser entry and the skew-protection adapter contract are all bundler-neutral. The part that is specific to Vite is small: hooks that emit `version.json`, serve it in development, and write adapter files.

## Decision

The build-tool package is `@rndsqr/usher-plugin`, and the bundler is a subpath: `@rndsqr/usher-plugin/vite`. The package has no root export. The browser entry is `/client`, and the adapter contract is `/adapter`, which names no bundler types.

There is no unplugin layer and no internal bundler interface. A second bundler would be a sibling entry that reuses the neutral modules.

## Consequences

- Adding a bundler does not rename a package or move an import that apps already use.
- An adapter for another host imports only `/adapter`, so it never pulls in Vite. The Cloudflare package uses those types alone, which is why the plugin is an optional peer for apps that import just the asset fallback handler.
- With one bundler, an abstraction over bundlers would be a seam with one adapter, so its shape would be a guess. The second bundler will show what is shared.
- The cost is that a second entry starts by copying the Vite entry's structure. If a third arrives and the copies agree, that is the time to extract what they share.
