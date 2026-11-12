# app-version

Keeps open tabs on a current build with as little disruption as possible. Pairs with R2 skew protection: old tabs keep working, so users are moved forward with prompts, not forced reloads.

See the [glossary](GLOSSARY.md) for domain terms and the [architecture](docs/Skew%20protection%20architecture.md) for package ownership, request handling, and deployment steps.

| Package                   | Import                     | What                                                                                                             | Needs       |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------- |
| `@app-version/core`       | `@app-version/core`        | `createAppUpdates({ current, url, ... })`: the update store; `connectUpdateSurface()`: drive any toast/banner UI | —           |
| `@app-version/vite`       | `@app-version/vite`        | `appVersion()` plugin: writes `version.json`, embeds the build facts, runs a skew adapter                        | Vite        |
|                           | `@app-version/vite/client` | `createAppUpdates()`: the core store with embedded build facts; `runningBuild`                                   | Vite plugin |
| `@app-version/react`      | `@app-version/react`       | `useUpdateState(updates)`, `useRefreshBlocker(updates, shouldBlock)`                                             | React       |
| `@app-version/cloudflare` | `@app-version/cloudflare`  | `cloudflarePages()`, `cloudflareWorkers()`: skew-protection adapters that serve old chunks from R2               | Cloudflare  |

## Setup

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { appVersion } from '@app-version/vite'
export default defineConfig({ plugins: [react(), appVersion()] })
```

The plugin and its browser helper live in `@app-version/vite`. Core takes build facts explicitly and does not import Vite. To read the running build's facts, for example to tag RUM events, import `runningBuild` from `@app-version/vite/client`.

Serve `version.json` uncached (the client also adds a `t` query parameter):

```
/version.json
  Cache-Control: no-store
```

### Skew protection (optional)

Pass an adapter from a provider package. Each factory returns a `SkewProtectionAdapter`: a `name` and a `files(build)` function that describes the files the host needs. The plugin writes them.

```ts
import { cloudflarePages, cloudflareWorkers } from '@app-version/cloudflare'

appVersion({ skewProtection: cloudflarePages() }) // { r2Binding? }
appVersion({
  skewProtection: cloudflareWorkers({ workerFile: 'dist-worker/index.mjs' }),
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

#### Apps that already have a Worker

If the app owns its Worker or Pages Functions, pass no adapter to the plugin and call the handler for the requests the app does not answer itself:

```ts
import { createAssetFallback } from '@app-version/cloudflare/worker'

const assets = createAssetFallback() // { base?, assetsDir?, r2Binding? }

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return api(request, env)
    }

    return assets(request, env)
  },
}
```

The app then owns its routing: `_routes.json` on Pages, or `assets.run_worker_first` on Workers, must send the assets prefix to the worker. Keep `base` and `assetsDir` in step with the Vite config. The handler needs the static assets binding as `ASSETS`.

## Use it in an app

```ts
import { createAppUpdates } from '@app-version/vite/client'

const HOUR = 60 * 60 * 1000

export const appUpdates = createAppUpdates({
  promptAfter: 12 * HOUR,
  urgentAfter: 24 * HOUR,
})
```

For a different build tool, pass the running build and version URL to core:

```ts
import { createAppUpdates } from '@app-version/core'

export const appUpdates = createAppUpdates({
  current: {
    version: 'commit-sha',
    commitTime: '2026-11-11T15:00:00Z',
    buildTime: '2026-11-11T16:00:00Z',
  },
  url: '/version.json',
})
```

```tsx
import { useUpdateState, useRefreshBlocker } from '@app-version/react'

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
}
```

Create one store at module scope. It starts polling when the first subscriber arrives and stops after the last leaves. `useUpdateState` returns the whole state and defers it with `useDeferredValue`, so a store change never blocks input. Actions read the current store directly.

## Update state

| Situation                                       | Attention | Reason      |
| ----------------------------------------------- | --------- | ----------- |
| No response yet                                 | `none`    | `unknown`   |
| Running the latest build                        | `none`    | `caught-up` |
| A newer build is being served                   | `passive` | `outdated`  |
| The prompt was dismissed                        | `passive` | `dismissed` |
| Running build is at least 12 hours old          | `prompt`  | `outdated`  |
| Running build is at least 24 hours old          | `urgent`  | `outdated`  |
| An older commit was deployed                    | `urgent`  | `rollback`  |
| Running build predates the forced-update cutoff | `urgent`  | `forced`    |

Rollback and forced-update knowledge stays urgent until this tab reloads, even if a later response reports the running version again. A forced cutoff applies even when the version matches. Urgent states cannot be dismissed.

A prompt dismissal records its server time in localStorage. It quiets every tab whose prompt threshold had started at that time, until each tab reaches urgent. A build that reaches its prompt threshold later can still prompt. An explicit `promptSnooze` can set a shorter or longer duration; it never suppresses urgent. With urgent disabled and no explicit snooze, a dismissed prompt has no expiry.

## Store interface

```ts
interface AppUpdates {
  getState(): UpdateState
  subscribe(listener: () => void): () => void
  addRefreshBlocker(blocker: () => boolean): () => void
  refresh(): Promise<boolean>
  dismiss(): boolean
}
```

Snapshots keep the same identity until attention, reason, or any of the latest build facts change. `dismiss()` succeeds only for a prompt that can still be lowered. It returns false without writing storage for urgent, passive, and unknown states.

| Option         | Default                                       | Meaning                                                                                                                            |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `running`      | Required by core; embedded by the Vite helper | Build facts for the running build.                                                                                                 |
| `versionUrl`   | Required by core; supplied by the Vite helper | The serving deployment's `version.json` URL.                                                                                       |
| `promptAfter`  | 12 hours                                      | Build age in milliseconds at which an outdated tab reaches prompt attention. `false` turns the level off.                          |
| `urgentAfter`  | 24 hours                                      | Build age in milliseconds at which it reaches urgent attention. `false` turns the level off. Must be later than `promptAfter`.     |
| `promptSnooze` | Until urgent                                  | How long, in milliseconds, a prompt dismissal quiets prompt attention.                                                             |
| `pollInterval` | 5 minutes                                     | Visible-tab polling interval in milliseconds, at least 10 seconds. Focus and visibility can also trigger a check after one minute. |
| `reload`       | `location.reload()`                           | The document load a refresh performs. May return or resolve false to decline.                                                      |
| `storageKey`   | `app-version`                                 | Set separately for apps on the same origin.                                                                                        |

There are no cancelable attention changes, input-idle delays, navigation reloads, or chunk-error reloads. Apps can subscribe to observe state. R2 fallback keeps old chunks available; the library refreshes only when the app calls `refresh()`.

### Refresh and unsaved work

Refresh blockers decide whether an explicit refresh can proceed. A throwing blocker blocks the refresh. The optional `reload` function decides how to refresh; concurrent refresh calls share one attempt. A failure or a declined attempt does not prevent a later retry.

To reuse a router's blockers:

```ts
reload: async () => {
  await router.navigate({
    href: window.location.href,
    reloadDocument: true,
    replace: true,
  })
  return false // The page is still here because the router declined the reload.
}
```

This recipe is tested against TanStack Router. For a refresh, current and next paths match, so a router blocker must check dirty state rather than a pathname change.

## Update surfaces

`connectUpdateSurface` drives an imperative toast or banner library from the store:

```ts
import { connectUpdateSurface, type UpdateNotice } from '@app-version/core'

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

## Internal modules

The [architecture document](docs/Skew%20protection%20architecture.md) describes the modules inside each package.

## Rollbacks and deployment

Dashboard rollbacks and old-commit redeploys are detected through `commitTime`. The build needs `.git` or `APP_COMMIT_TIME`; the plugin warns when neither exists. For a revert deployed as a new commit, set `APP_FORCE_UPDATE_BEFORE` for that deployment. Clearing it later does not lower urgency in tabs that already saw it.

Deploy one Workers version at a time. Alternating version responses during a gradual deployment can look like a rollback. R2 keeps serving bad-build tabs until their users refresh.

## Development

A pnpm workspace run by Turbo: `packages/*` are the libraries (built with tsdown), `apps/*` are sample Vite + React apps for Pages and Workers.

| Script              | Runs                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Coverage first, then all checks in parallel                                                                                                         |
| `pnpm build`        | tsdown for each package, then the apps                                                                                                              |
| `pnpm check:types`  | `tsc` per package and app (plus Workers types for the edge tests)                                                                                   |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules                                       |
| `pnpm format`       | oxfmt (`pnpm check:format` checks)                                                                                                                  |
| `pnpm test`         | Vitest: Node for everything that doesn't need a browser, Chromium (browser mode) for what does; MSW for the network                                 |
| `pnpm test:edge`    | The emitted worker in workerd, with real R2 and Cloudflare asset serving                                                                            |
| `pnpm coverage`     | V8 coverage, merged for Fallow; each package must reach 95% on lines, branches, functions and statements                                            |
| `pnpm check:fallow` | Fallow with merged coverage (run `pnpm coverage` first): dead code, duplication, complexity, dependencies                                           |
| `pnpm check:pack`   | Packs the four packages, installs the tarballs into a throwaway app outside the workspace, and runs its type check, production build and dev server |
