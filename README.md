# app-version

Keeps open tabs on a current build with as little disruption as possible. Pairs with R2 skew protection: old tabs keep working, so users are moved forward with prompts, not forced reloads.

See the [glossary](GLOSSARY.md) for domain terms and the [architecture](docs/Skew%20protection%20architecture.md) for package ownership, request handling, and deployment steps.

| Package                   | Import                     | What                                                                                                      | Needs       |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| `@app-version/core`       | `@app-version/core`        | `createAppUpdates({ current, url, ... })`: the update store; `connectPrompt()`: drive any toast/banner UI | —           |
| `@app-version/vite`       | `@app-version/vite`        | `appVersion()` plugin: writes `version.json`, provides `virtual:app-version`, runs a skew adapter         | Vite        |
|                           | `@app-version/vite/client` | `createAppUpdates()`: creates the core store using embedded build facts and the version URL               | Vite plugin |
| `@app-version/react`      | `@app-version/react`       | `useAppUpdates(store, selector?)`, `useReloadBlocker(store, shouldBlock)`                                 | React       |
| `@app-version/cloudflare` | `@app-version/cloudflare`  | `cloudflarePages()`, `cloudflareWorkers()`: skew-protection adapters that serve old chunks from R2        | Cloudflare  |

## Setup

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { appVersion } from '@app-version/vite'
export default defineConfig({ plugins: [react(), appVersion()] })
```

The plugin and its browser helper live in `@app-version/vite`. Core takes build facts explicitly and does not import Vite or a virtual module. If you import `virtual:app-version` directly, add `@app-version/vite/virtual` to your TypeScript `types` list.

Serve `version.json` uncached (the client also adds `?t=`):

```
/version.json
  Cache-Control: no-store
```

### Skew protection (optional)

Pass an adapter from a provider package. Each factory returns the same `SkewProtectionAdapter` interface, with hooks for bundle assets or output outside the client directory:

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

The handler (`packages/cloudflare/src/edge-handler.mjs`, standalone ESM) serves the current deploy's file, falls back to R2 on a 404 or an SPA-fallback HTML response, and returns a real 404 when neither has it. R2 keys are paths relative to `base`, matching `aws s3 sync dist/assets s3://<bucket>/assets` in CI.

## Use it in an app

```ts
import { createAppUpdates } from '@app-version/vite/client'

export const appUpdates = createAppUpdates({
  escalation: { prompt: { after: '12h' }, urgent: { after: '24h' } },
})
```

For a different build tool, pass the running build and version URL to core:

```ts
import { createAppUpdates } from '@app-version/core'

export const appUpdates = createAppUpdates({
  current: {
    version: 'commit-sha',
    commitTime: '2026-11-11T15:00:00Z',
    builtAt: '2026-11-11T16:00:00Z',
  },
  url: '/version.json',
})
```

```tsx
import { useAppUpdates, useReloadBlocker } from '@app-version/react'

function UpdateButton() {
  const attention = useAppUpdates(appUpdates, state => state.attention)
  if (attention === 'none') return null
  return (
    <button type="button" onClick={() => appUpdates.refresh()}>
      Refresh
    </button>
  )
}

function JobForm() {
  const form = useForm()
  useReloadBlocker(appUpdates, form.formState.isDirty)
}
```

Create one store at module scope. It starts polling when the first subscriber arrives and stops after the last leaves. Select a stable field with `useAppUpdates`; a selector that creates a new object is not supported. The hook defers the selected value with `useDeferredValue`. Actions read the current store directly.

## Update state

| Situation                                       | Attention | Reason      |
| ----------------------------------------------- | --------- | ----------- |
| No response yet                                 | `none`    | `unknown`   |
| Running the latest build                        | `none`    | `caught-up` |
| A newer build exists                            | `passive` | `new-build` |
| The prompt was dismissed                        | `passive` | `dismiss`   |
| Running build is at least 12 hours old          | `prompt`  | `stale`     |
| Running build is at least 24 hours old          | `urgent`  | `expired`   |
| An older commit was deployed                    | `urgent`  | `rollback`  |
| Running build predates the forced-update cutoff | `urgent`  | `forced`    |

Rollback and forced-update knowledge stays urgent until this tab reloads, even if a later response reports the running version again. A forced cutoff applies even when the version matches. Urgent states cannot be dismissed.

A prompt dismissal records its server time in localStorage. It quiets every tab whose prompt threshold had started at that time, until each tab reaches urgent. A build that reaches its prompt threshold later can still prompt. An explicit `prompt.snooze` can set a shorter or longer duration; it never suppresses urgent. With urgent disabled and no explicit snooze, a dismissed prompt has no expiry.

## Store interface

```ts
interface AppUpdates {
  getState(): UpdateState
  subscribe(listener: () => void): () => void
  addReloadBlocker(blocker: (details: { href: string }) => boolean): () => void
  refresh(): Promise<boolean>
  dismiss(): boolean
}
```

Snapshots keep the same identity until attention, reason, or latest version changes. `dismiss()` succeeds only for a prompt that can still be lowered. It returns false without writing storage for urgent, passive, and unknown states.

| Option       | Default                                       | Meaning                                                                                                       |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `current`    | Required by core; embedded by the Vite helper | Build facts for the running application.                                                                      |
| `url`        | Required by core; supplied by the Vite helper | The serving deployment's `version.json` URL.                                                                  |
| `escalation` | Prompt at `12h`, urgent at `24h`              | Typed build-age thresholds. Set either level to `false` to disable it. Only prompt accepts `snooze`.          |
| `pollEvery`  | `5m`                                          | Visible-tab polling interval, at least `10s`. Focus and visibility can also trigger a check after one minute. |
| `reload`     | `location.reload()`                           | An explicit refresh. Receives `{ href }`; may return or resolve false to decline.                             |
| `storageKey` | `app-version`                                 | Set separately for apps on the same origin.                                                                   |

There are no cancelable attention changes, input-idle delays, navigation reloads, or chunk-error reloads. Apps can subscribe to observe state. R2 fallback keeps old chunks available; the library refreshes only when the app calls `refresh()`.

### Refresh and unsaved work

Reload blockers decide whether an explicit refresh can proceed. A throwing blocker blocks the refresh. The optional `reload` function decides how to refresh; concurrent refresh calls share one attempt. A failure or a declined attempt does not prevent a later retry.

To reuse a router's blockers:

```ts
reload: async ({ href }) => {
  await router.navigate({ href, reloadDocument: true, replace: true })
  return false // The page is still here because the router declined the reload.
}
```

This recipe is tested against TanStack Router. For a refresh, current and next paths match, so a router blocker must check dirty state rather than a pathname change.

## Prompt adapters

`connectPrompt` remains available for imperative toast and banner libraries:

```ts
import { connectPrompt, defaultCopy } from '@app-version/core'

const disconnect = connectPrompt(appUpdates, {
  show(prompt) {
    // Upsert by prompt.id. Wire the refresh action to prompt.refresh().
    // Allow closing only when prompt.attention !== 'urgent'.
    // Wire a user close to prompt.dismiss().
    showToast(prompt.id, defaultCopy(prompt), prompt)
  },
  hide() {
    hideToast('app-update')
  },
})
```

The adapter has a real seam: different UI libraries implement `show` and `hide`. `connectPrompt` handles threshold changes, stable IDs, stale handles, and a library firing onClose during a programmatic hide. The default minimum attention is `prompt`; use `minAttention: 'passive'` for a persistent update banner. A passive banner can be closed locally until its attention or reason changes. Calling an urgent handle's `dismiss()` has no effect; render urgent surfaces without a close action.

`disconnect()` hides the surface and removes its store subscription. An adapter that throws is isolated and can retry on a later state notification. `defaultCopy` supplies suggested text; apps can use their own text.

## Internal modules

`app-updates.ts` owns observed build facts, sticky rollback or forced-update knowledge, the published snapshot, and subscribers. It also handles prompt dismissal. `attention.ts` computes attention and the next deadline from those facts, the dismissal record, and an explicit server time. It does not read clocks or store results.

`update-monitor.ts` owns fetching, browser events, clock correction, and the wake timer. It asks the store to evaluate new observations and time changes. When scheduling, it derives the delay from the next server-time deadline and the current corrected time. `prompt-dismissal.ts` owns persistence and merging of the shared dismissal record.

`browser.ts` defines the browser capabilities used by the store and monitor. Its default implementation reads browser globals on access. `refresh.ts` owns explicit refresh attempts, reload blockers, and sharing of concurrent attempts.

Build age and dismissals use the response's Date header, anchored to `performance.now()`. Before a Date header has been received, the monitor uses the local clock. Missing Date headers retain the last estimate. Changes smaller than two seconds are ignored as header rounding. Polling uses monotonic time, so changing the user's clock cannot stop it. Cross-origin version responses need `Access-Control-Expose-Headers: Date` for clock correction.

The monitor triggers age evaluation even when network checks fail. Hidden tabs have no wake timer; they catch up when visible or subscribed again. A pending fetch retains its own 30-second timeout and is aborted when the final subscriber leaves. External JSON is validated. Blocked storage keeps prompt dismissal in memory for the current tab.

Behaviour tests cover these rules. Model tests also exercise random event sequences with slow responses, outages, clock skew, clock jumps, resubscription, cross-tab dismissal, and rollback followed by a fix.

## Rollbacks and deployment

Dashboard rollbacks and old-commit redeploys are detected through `commitTime`. The build needs `.git` or `APP_COMMIT_TIME`; the plugin warns when neither exists. For a revert deployed as a new commit, set `APP_FORCE_UPDATE_BEFORE` for that deployment. Clearing it later does not lower urgency in tabs that already saw it.

Deploy one Workers version at a time. Alternating version responses during a gradual deployment can look like a rollback. R2 keeps serving bad-build tabs until their users refresh.

## Development

A pnpm workspace run by Turbo: `packages/*` are the libraries (built with tsdown), `apps/*` are sample Vite + React apps for Pages and Workers.

| Script              | Runs                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Coverage first, then all checks in parallel                                                                         |
| `pnpm build`        | tsdown for each package, then the apps                                                                              |
| `pnpm check:types`  | `tsc` per package and app (plus Workers types for the edge tests)                                                   |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules       |
| `pnpm format`       | oxfmt (`pnpm check:format` checks)                                                                                  |
| `pnpm test`         | Vitest: Node for everything that doesn't need a browser, Chromium (browser mode) for what does; MSW for the network |
| `pnpm test:edge`    | The emitted worker in workerd, with real R2 and Cloudflare asset serving                                            |
| `pnpm coverage`     | V8 coverage, merged for Fallow; each package must reach 95% on lines, branches, functions and statements            |
| `pnpm check:fallow` | Fallow with merged coverage (run `pnpm coverage` first): dead code, duplication, complexity, dependencies           |
