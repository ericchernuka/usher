# Contributing to Usher

Usher is a pnpm workspace managed by Turbo. `packages/*` contains the libraries built with tsdown, and `examples/react/*` contains sample Vite and React apps for Cloudflare Pages and Workers.

## Prerequisites

- Node.js 22, 24, or 26 (see `engines` in `package.json`)
- pnpm 12 (`packageManager` in `package.json`)
- Playwright browsers for browser and screen-reader tests:

```sh
pnpm exec playwright install chromium webkit
```

## Scripts

| Script              | Runs                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Coverage first, then all checks in parallel                                                                                                           |
| `pnpm build`        | tsdown for each package, then the examples                                                                                                            |
| `pnpm check:types`  | `tsc` per package and example (plus Workers types for the edge tests)                                                                                 |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules                                         |
| `pnpm format`       | oxfmt (`pnpm check:format` checks formatting)                                                                                                         |
| `pnpm test`         | Vitest: Node for pure unit tests, Chromium (browser mode) for browser tests, and WebKit for screen-reader announcement tests; MSW for network mocking |
| `pnpm test:edge`    | Generated and composed workers in workerd, with R2 and asset serving                                                                                  |
| `pnpm coverage`     | V8 coverage, merged for Fallow; each package must reach 95% on lines, branches, functions, and statements                                             |
| `pnpm check:fallow` | Fallow with merged coverage (run `pnpm coverage` first): dead code, duplication, complexity, and dependencies                                         |
| `pnpm check:pack`   | Packs the four packages, installs the tarballs into a throwaway app outside the workspace, and runs its type check, production build, and dev server  |

## Releases

Versions are managed with [Changesets](.changeset/README.md). Run `pnpm changeset` in any pull request that changes a published package. All four packages share one version.

The [release workflow](.github/workflows/release.yml) handles publishing. When changesets land on `main`, it opens a "Version Packages" pull request that bumps versions and updates changelogs. Merging that pull request publishes to npm through trusted publishing and creates one GitHub release, `v<version>`, with notes generated from the merged pull requests. Locally, `pnpm version-packages` and `pnpm release` run the same two steps.

Each release job gets only the permissions it needs. Only the publish job can obtain npm credentials; it runs in the `npm` environment and never builds packages or runs dependency install scripts. The [CI workflow](.github/workflows/ci.yml) runs `pnpm check` and audits workflows with zizmor on every pull request, and Dependabot keeps SHA-pinned actions current.
