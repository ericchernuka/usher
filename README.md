# Usher

Usher keeps open tabs on a current build with as little disruption as possible. It pairs update prompts with skew protection: old tabs keep working after a deploy because their chunks stay reachable, so users are asked to refresh and are never reloaded by force.

The [glossary](GLOSSARY.md) defines the domain terms. The [architecture document](docs/Skew%20protection%20architecture.md) covers package ownership, internal modules, request handling and deployment.

| Import                            | What it gives you                                                                        | Needs      |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ---------- |
| `@rndsqr/usher-plugin/vite`       | `usher()`: writes `version.json`, embeds the build facts, runs a skew-protection adapter | Vite       |
| `@rndsqr/usher-plugin/adapter`    | `SkewProtectionAdapter` and its types, for writing an adapter for another host           | Nothing    |
| `@rndsqr/usher-plugin/client`     | `createAppUpdates()` with the build facts filled in, and `runningBuild`                  | The plugin |
| `@rndsqr/react-usher`             | `useUpdateState(updates)`, `useRefreshBlocker(updates, shouldBlock)`                     | React      |
| `@rndsqr/usher-cloudflare`        | `cloudflarePages()`, `cloudflareWorkers()`: adapters that serve old chunks from R2       | Cloudflare |
| `@rndsqr/usher-cloudflare/worker` | `createAssetFallback()`: the same handler, for apps that own their Worker                | Cloudflare |
| `@rndsqr/usher-core`              | `createAppUpdates(options)` and `connectUpdateSurface()`, with no build tool             | Nothing    |

## Setup

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { usher } from '@rndsqr/usher-plugin/vite'

export default defineConfig({ plugins: [react(), usher()] })
```

Serve `version.json` uncached. The client also adds a `t` query parameter to each check.

```
/version.json
  Cache-Control: no-store
```

| Plugin option            | Default                                           | Meaning                                                                                                                                |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `fileName`               | `version.json`                                    | Output file, relative to `outDir` and `base`.                                                                                          |
| `version`                | `APP_VERSION`, `GITHUB_SHA`, then `git rev-parse` | The source version of the build.                                                                                                       |
| `commitTime`             | `APP_COMMIT_TIME`, then `git log`                 | ISO 8601 commit time, used to detect rollbacks.                                                                                        |
| `forceUpdateBuiltBefore` | `APP_FORCE_UPDATE_BUILT_BEFORE`                   | ISO 8601 build time. Tabs running a build made before it become urgent. Not a deadline: a value later than this build fails the build. |
| `adapter`                | None                                              | A skew-protection adapter. See below.                                                                                                  |

## Use it in an app

Create one store at module scope. Creating it has no side effects. It polls while it has at least one subscriber and stops after the last one leaves.

```ts
// updates.ts
import { createAppUpdates } from '@rndsqr/usher-plugin/client'

export const appUpdates = createAppUpdates()
```

```tsx
import { useRefreshBlocker, useUpdateState } from '@rndsqr/react-usher'
import { appUpdates } from './updates'

function UpdateButton() {
  const { attention } = useUpdateState(appUpdates)

  if (attention === 'none') return null

  return (
    <button type="button" onClick={() => appUpdates.refresh()}>
      Refresh
    </button>
  )
}

function JobForm() {
  const form = useForm()
  useRefreshBlocker(appUpdates, form.formState.isDirty)

  return null
}
```

`useUpdateState` returns the whole state and defers it, so a store change never blocks input. Read the field you need from it. `useRefreshBlocker` takes a boolean or a function; an inline function is fine, because the hook registers once and calls the latest one.

To tag error reports or RUM events with the running build, import its facts:

```ts
import { runningBuild } from '@rndsqr/usher-plugin/client'

reportError(error, { version: runningBuild.version })
```

With another build tool, pass the running build and the version URL to core yourself:

```ts
import { createAppUpdates } from '@rndsqr/usher-core'

export const appUpdates = createAppUpdates({
  running: {
    version: 'commit-sha',
    commitTime: '2026-11-11T15:00:00Z',
    buildTime: '2026-11-11T16:00:00Z',
  },
  versionUrl: '/version.json',
})
```

## Update state

| Situation                                       | Attention | Reason      |
| ----------------------------------------------- | --------- | ----------- |
| No response yet                                 | `none`    | `unknown`   |
| Running the latest build                        | `none`    | `caught-up` |
| A newer build is being served                   | `passive` | `outdated`  |
| The prompt was dismissed                        | `passive` | `dismissed` |
| Outdated for at least 12 hours                  | `prompt`  | `outdated`  |
| Outdated for at least 24 hours                  | `urgent`  | `outdated`  |
| An older commit was deployed                    | `urgent`  | `rollback`  |
| Running build predates the forced-update cutoff | `urgent`  | `forced`    |

Every state except `unknown` carries `latest`, the build facts the server reported.

A tab is outdated from the build time of the first newer build it sees, not from the age of its own build. A tab opened a minute ago on last week's build is one minute behind when the next deploy lands, so it starts passive. Later deploys do not restart the count, so a team that deploys a hundred times a day and a team that deploys once a week both prompt after 12 hours behind and turn urgent after 24. If the tab catches up, for example after a rollback to its build, the count starts over.

Rollback and forced-update knowledge stays urgent until the tab reloads, even if a later response reports the running version again. A forced cutoff applies even when the version matches. Urgent attention cannot be dismissed.

A prompt dismissal records its server time in localStorage. It quiets every tab whose prompt threshold had already started, until each tab reaches urgent attention. A build that reaches its prompt threshold later can still prompt. `promptSnooze` sets a shorter or longer quiet period; it never quiets urgent attention. With `urgentAfter: false` and no `promptSnooze`, a dismissed prompt stays dismissed.

## The store

```ts
interface AppUpdates {
  getState(): UpdateState
  subscribe(listener: () => void): () => void
  refresh(): Promise<'reloading' | 'blocked' | 'declined'>
  dismiss(): boolean
  addRefreshBlocker(blocker: () => boolean): () => void
}
```

`getState()` returns the same object until attention, reason, or any of the latest build facts change. `dismiss()` returns `true` only when it lowered a prompt; otherwise it returns `false` and writes nothing.

Durations are milliseconds, so they can be computed:

```ts
import { createAppUpdates } from '@rndsqr/usher-plugin/client'

const HOUR = 60 * 60 * 1000

export const appUpdates = createAppUpdates({
  promptAfter: 4 * HOUR,
  urgentAfter: 12 * HOUR,
})
```

| Option         | Default                            | Meaning                                                                                                                |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `running`      | Required by core; set by `/client` | Build facts of the running build.                                                                                      |
| `versionUrl`   | Required by core; set by `/client` | The serving deployment's `version.json` URL.                                                                           |
| `promptAfter`  | 12 hours                           | Time outdated at which a tab reaches prompt attention. `false` turns the level off.                                    |
| `urgentAfter`  | 24 hours                           | Time outdated at which it reaches urgent attention. `false` turns the level off. Must be later than `promptAfter`.     |
| `promptSnooze` | Until urgent attention starts      | How long a prompt dismissal quiets prompt attention.                                                                   |
| `pollInterval` | 5 minutes                          | How often a visible tab checks, at least 10 seconds. Focus and visibility also trigger a check, at most once a minute. |
| `reload`       | `location.reload()`                | The document load a refresh performs. Return or resolve `false` when you know it did not happen.                       |
| `storageKey`   | `usher`                            | Set one per app when apps share an origin.                                                                             |

Invalid options throw when the store is created, with a message that names the option.

Usher never reloads on navigation, on a chunk error, or on its own timer. The asset fallback keeps old chunks available, and the tab refreshes only when the app calls `refresh()`.

### Refresh and unsaved work

Refresh blockers decide whether a refresh can proceed. They run synchronously, in the order they were added, and a blocker that returns `true` or throws blocks the refresh. In React, `useRefreshBlocker(appUpdates, isDirty)` registers one for as long as the component is mounted.

`refresh()` resolves with what happened:

| Outcome     | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `reloading` | `reload` ran and the document is being replaced.         |
| `blocked`   | A refresh blocker stopped it. `reload` was never called. |
| `declined`  | `reload` returned `false` or threw. The error is logged. |

Nothing is remembered between calls, so any outcome can be retried, and concurrent calls share one attempt. To let the user override a blocker, confirm on `blocked`, remove the blocker, and call `refresh()` again:

```ts
if ((await appUpdates.refresh()) === 'blocked' && confirm('Discard changes?')) {
  discardChanges() // the blocker now returns false
  await appUpdates.refresh()
}
```

To send the reload through a router, replace `reload`:

```ts
import { createAppUpdates } from '@rndsqr/usher-plugin/client'

export const appUpdates = createAppUpdates({
  reload: () =>
    router.navigate({
      href: window.location.href,
      reloadDocument: true,
      replace: true,
    }),
})
```

This recipe is tested against TanStack Router, whose own blockers then apply to the reload. The router does not report a blocked navigation, so `refresh()` resolves `reloading` either way; use a refresh blocker when the app needs to know. For a refresh the current and next paths match, so a router blocker must check dirty state, not a pathname change.

## Update surfaces

`connectUpdateSurface` drives an imperative toast or banner library from the store:

```ts
import { connectUpdateSurface, type UpdateNotice } from '@rndsqr/usher-core'

const TOAST_ID = 'app-update'

const disconnect = connectUpdateSurface(appUpdates, {
  show(notice) {
    showToast(TOAST_ID, {
      ...copyFor(notice),
      onAction: () => notice.refresh(),
      // Render urgent notices without a close control.
      onClose: notice.attention === 'urgent' ? undefined : () => notice.close(),
    })
  },
  hide() {
    hideToast(TOAST_ID)
  },
})

function copyFor({ attention, reason }: UpdateNotice) {
  if (reason === 'rollback' || reason === 'forced') {
    return {
      title: 'Please refresh',
      description: 'This version has a known issue. Refresh to get the fix.',
      action: 'Refresh now',
    }
  }

  if (attention === 'urgent') {
    return {
      title: 'Please refresh',
      description: "You're on an old version of the app. Refresh to update.",
      action: 'Refresh now',
    }
  }

  return {
    title: 'A new version is available',
    description: "Refresh when you're ready.",
    action: 'Refresh',
  }
}
```

`show` is called once per change of attention or reason, with a new notice each time. The surface owns its toast id and its wording. The default minimum attention is `prompt`; use `minAttention: 'passive'` for a persistent update banner.

`notice.close()` means the user closed the surface. For a prompt it dismisses the prompt for every tab and then calls `hide()`. For a passive notice it calls `hide()` and stays hidden until attention or reason changes. For an urgent notice it calls `show()` again with a new notice, because urgent attention cannot be closed and some libraries remove a toast regardless. A notice that is no longer the one shown ignores `close()`, so a library that fires `onClose` during a programmatic hide is safe.

`disconnect()` hides the surface and removes its store subscription. A surface that throws is isolated and retried on the next state change.

## Skew protection

Skew protection is optional. Pass an adapter from a provider package, and the plugin writes the files that host needs:

```ts
import { cloudflarePages, cloudflareWorkers } from '@rndsqr/usher-cloudflare'

usher({ adapter: cloudflarePages() }) // { r2Binding? }
usher({
  adapter: cloudflareWorkers({ workerFile: 'dist-worker/index.mjs' }),
}) // { r2Binding?, workerFile? }
```

| Adapter               | Writes                                                                                      | You configure                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cloudflarePages()`   | `dist/_worker.js` (Pages advanced mode) and `dist/_routes.json` limited to `<base>assets/*` | An R2 binding on the Pages project. Pages ignores `functions/` once `_worker.js` exists |
| `cloudflareWorkers()` | `dist-worker/index.js` (`.js` or `.mjs`), outside `dist` so it's never served publicly      | `wrangler.jsonc`: `main`, `assets.run_worker_first: ["/assets/*"]`, the R2 binding      |

The generated worker serves the current deploy's file, falls back to R2 on a 404 or an SPA-fallback HTML response, and returns a real 404 when neither has it. Requests outside the assets prefix go straight to static assets. R2 keys are paths relative to `base`, matching `aws s3 sync dist/assets s3://<bucket>/assets` in CI. The R2 binding defaults to `CHUNK_ARCHIVE`.

For Workers, point wrangler at the generated entry:

```jsonc
// wrangler.jsonc
{
  "main": "dist-worker/index.js",
  "assets": {
    "directory": "dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/assets/*"],
  },
  "r2_buckets": [{ "binding": "CHUNK_ARCHIVE", "bucket_name": "<bucket>" }],
}
```

### Apps that already have a Worker

If the app owns its Worker or Pages Functions, pass no adapter to the plugin and call the handler for the requests the app does not answer itself:

```ts
import {
  createAssetFallback,
  type AssetFallbackEnv,
} from '@rndsqr/usher-cloudflare/worker'

const assets = createAssetFallback() // { base?, assetsDir?, r2Binding? }

export default {
  fetch(request: Request, env: AssetFallbackEnv) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return api(request, env)
    }

    return assets(request, env)
  },
}
```

The app then owns its routing: `_routes.json` on Pages, or `assets.run_worker_first` on Workers, must send the assets prefix to the worker. Keep `base` and `assetsDir` in step with the Vite config. The handler needs the static assets binding as `ASSETS`.

## Rollbacks and deployment

Dashboard rollbacks and old-commit redeploys are detected through `commitTime`. The build needs `.git` or `APP_COMMIT_TIME`; the plugin warns when neither exists. For a revert deployed as a new commit, set `APP_FORCE_UPDATE_BUILT_BEFORE` to the time of that build (`date -u +%Y-%m-%dT%H:%M:%SZ` in the deploy job), so every tab built before the fix becomes urgent. It is a build time, not a deadline. A value later than the build itself fails the build, because no refresh could ever satisfy it. Clearing it in a later deploy does not lower urgency in tabs that already saw it.

Deploy one Workers version at a time. Alternating version responses during a gradual deployment can look like a rollback. R2 keeps serving bad-build tabs until their users refresh.

## Development

A pnpm workspace run by Turbo. `packages/*` are the libraries, built with tsdown. `examples/react/*` are sample Vite and React apps for Pages and Workers.

| Script              | Runs                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Coverage first, then all checks in parallel                                                                                                         |
| `pnpm build`        | tsdown for each package, then the examples                                                                                                          |
| `pnpm check:types`  | `tsc` per package and example (plus Workers types for the edge tests)                                                                               |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules                                       |
| `pnpm format`       | oxfmt (`pnpm check:format` checks)                                                                                                                  |
| `pnpm test`         | Vitest: Node for everything that doesn't need a browser, Chromium (browser mode) for what does; MSW for the network                                 |
| `pnpm test:edge`    | The generated and composed workers in workerd, with R2 and asset serving                                                                            |
| `pnpm coverage`     | V8 coverage, merged for Fallow; each package must reach 95% on lines, branches, functions and statements                                            |
| `pnpm check:fallow` | Fallow with merged coverage (run `pnpm coverage` first): dead code, duplication, complexity, dependencies                                           |
| `pnpm check:pack`   | Packs the four packages, installs the tarballs into a throwaway app outside the workspace, and runs its type check, production build and dev server |

### Releases

Versions are managed with [Changesets](.changeset/README.md). Run `pnpm changeset` in any pull request that changes a published package. `pnpm version-packages` applies the pending changesets, and `pnpm release` builds and publishes. The four packages share one version.
