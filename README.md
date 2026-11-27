# Usher

Usher keeps running single-page apps working across deployments and guides users onto the latest build with minimal disruption.

It combines two independent pieces:

1. **Calm, escalating update prompts** that work with any host, respect unsaved work, and escalate only when a running build stays outdated past your limit or hits a rollback or forced update.
2. **Optional skew protection** that keeps previously shipped JS and CSS chunks reachable on hosts that replace static files on deploy, so older running builds keep working and users are never reloaded by force.

**Contents:** [Quick start](#quick-start) · [Update state](#update-state) · [Showing update UI](#showing-update-ui) · [Refresh and unsaved work](#refresh-and-unsaved-work) · [Development](#trying-the-flows-in-development) · [Testing](#testing-update-ui) · [Skew protection](#skew-protection) · [Rollbacks & forced updates](#rollbacks-and-forced-updates) · [Monitoring](#monitoring-in-production) · [Reference](#reference)

## Why Usher?

After a deploy, already-open clients (browser sessions, PWAs, Electron windows, mobile WebViews) still run the previous build in memory. When they lazy-load a route or modal, they request old content-hashed chunks. On hosts that overwrite the static directory on deploy, those requests return a `404` or an SPA fallback `index.html` with status `200`, breaking imports.

Instead of forcing hard reloads that discard unsaved forms, Usher:

- **Keeps older running builds working** through skew protection (your host's built-in support or an Usher adapter).
- **Prompts calmly** as a running app becomes outdated, while blocking refreshes when the user has unsaved work.
- **Escalates when needed**, moving straight to a non-dismissible urgent notice on rollbacks, forced updates, or after your time limit.

Usher never reloads on navigation, on a chunk error, or on its own timer. The app refreshes only when your code calls `refresh.run()`.

## Quick start

> **Requirements:** Vite 5+ for `@ericchernuka/usher-plugin` and React 19.2+ for `@ericchernuka/react-usher`. For other bundlers, see [Using Usher without Vite](#using-usher-without-vite).

Install the core package and Vite plugin, plus React helpers or Cloudflare skew protection if needed:

```sh
pnpm add @ericchernuka/usher-core
pnpm add -D @ericchernuka/usher-plugin

# Optional: React hooks and headless notice components
pnpm add @ericchernuka/react-usher

# Optional: Skew protection on Cloudflare Pages or Workers
pnpm add -D @ericchernuka/usher-cloudflare
```

`@ericchernuka/usher-core` is a peer dependency of the plugin and React packages so your app shares one copy.

Add the plugin to Vite:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { usher } from '@ericchernuka/usher-plugin/vite'

export default defineConfig({ plugins: [react(), usher()] })
```

Create one `appUpdates` instance at module scope. Creating it has no side effects: `appUpdates.state` runs version checks only while it has at least one subscriber.

```ts
// updates.ts
import { createAppUpdates } from '@ericchernuka/usher-plugin/client'

export const appUpdates = createAppUpdates()
```

Read update state and protect unsaved work in React:

```tsx
import {
  useRefreshBlocker,
  useRefreshing,
  useUpdateState,
} from '@ericchernuka/react-usher'
import { appUpdates } from './updates'

function UpdateButton() {
  const { attention } = useUpdateState(appUpdates.state)
  const refreshing = useRefreshing(appUpdates.refresh)

  if (attention === 'none') return null

  return (
    <button
      type="button"
      disabled={refreshing}
      onClick={() => appUpdates.refresh.run()}
    >
      Refresh
    </button>
  )
}

function JobForm() {
  const form = useForm() // e.g. react-hook-form
  useRefreshBlocker(appUpdates.refresh, form.formState.isDirty)

  return <form>{/* ... */}</form>
}
```

Each hook reads one behaviour:

- `useUpdateState(appUpdates.state)` returns the update state and defers updates so state changes never interrupt typing.
- `useRefreshing(appUpdates.refresh)` returns `true` while a reload is in flight and does not start version checks on its own.
- `useRefreshBlocker(appUpdates.refresh, isDirty)` accepts a boolean or callback; an inline function is safe because the hook registers once and calls the latest one.

### Required cache headers

Serve `version.json` uncached (the client also appends a `t` query parameter). On Cloudflare Pages and Workers Static Assets, add this to `public/_headers`:

```
/version.json
  Cache-Control: no-store
```

Keep `index.html` uncached at the edge (`Cache-Control: no-cache` or your host's default) so a refresh loads the latest build's HTML document.

## Update state

As deployments land, a running app moves through four attention levels:

```text
caught-up (none)
  │
  │  newer deploy observed
  ▼
outdated (passive) ── at 12h ──▶ (prompt) ── at 24h ──▶ (urgent)
                                     │
                      state.dismiss()│ (quiets until urgent)
                                     ▼
                            dismissed (passive)

Rollback or forced-update cutoff observed ────────────▶ urgent (sticky)
```

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

Every state except `unknown` includes `latest`, the build facts reported by the server.

- **Time outdated:** Measured from the build time of the first newer build seen (`outdated since`), not the running build's own age. Later deploys do not restart the clock, so deploy frequency does not change when prompts appear; catching up resets it.
- **Sticky urgency:** Rollback and forced-update urgency persists until reload, even if a later check reports the running version again. A forced-update cutoff applies even when the version matches, and urgent attention cannot be dismissed.
- **Prompt dismissal:** Stores its server timestamp in `localStorage`, quieting every eligible running app on the same origin until urgent attention (or for `promptSnooze`, never past urgent). With `urgentAfter: false` and no `promptSnooze`, a dismissed prompt stays dismissed.

## Showing update UI

Pick the integration that matches your UI stack:

- **Imperative toast or banner library (such as Sonner):** `connectUpdateSurface` from `@ericchernuka/usher-core`.
- **Custom banner or toast in React:** `UpdateNotice` components or `useUpdateNotice` from `@ericchernuka/react-usher`.
- **Nav indicator or custom logic:** `useUpdateState` and `useRefreshing`, shown in [Quick start](#quick-start).

### Connecting a toast or banner library

`connectUpdateSurface` drives an imperative toast or banner library from `appUpdates`:

```ts
import {
  connectUpdateSurface,
  type UpdateNotice,
} from '@ericchernuka/usher-core'

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

`show` runs once per change of `attention` or `reason` with a new notice. The default `minAttention` is `'prompt'`; pass `'passive'` for a persistent banner.

- **`notice.close()` at `prompt`:** Dismisses across eligible running apps on that origin and calls `hide()`.
- **`notice.close()` at `passive`:** Calls `hide()` until `attention` or `reason` changes. When unsubscribed and re-subscribed (such as inside a hidden React 19.2 `<Activity>`), it stays hidden only if the update state did not change.
- **`notice.close()` at `urgent`:** Calls `show()` again with a new notice. Outside `connectUpdateSurface`, closing an urgent notice is a no-op.
- **Timers and errors:** Inactive notices ignore `close()`, so `onClose` callbacks fired during `hide()` are safe. Never set an auto-dismiss timer on urgent notices (Usher stops and logs after five re-shows in one pass). `disconnect()` hides and unsubscribes; `show` errors are logged and retried on the next state change, and `hide` errors are logged once.
- **Notice fields:** Each notice carries `latest` (build facts at creation; read `appUpdates.state` for the current value), `closable` (`false` at `urgent`), and `announce` (`'off'`, `'polite'`, or `'assertive'`).

### Headless React components

Components that render their own markup can read the same notice via `useUpdateNotice(appUpdates, { minAttention })`, or compose the headless `UpdateNotice` parts:

```tsx
import { UpdateNotice } from '@ericchernuka/react-usher'
import { appUpdates } from './updates'

function UpdateBanner() {
  return (
    <UpdateNotice.Root
      updates={appUpdates}
      minAttention="passive"
      announcement={notice => copyFor(notice).title}
    >
      {notice => (
        <>
          <p>{copyFor(notice).title}</p>
          <UpdateNotice.Refresh>Refresh</UpdateNotice.Refresh>
          <UpdateNotice.Close aria-label="Close" />
        </>
      )}
    </UpdateNotice.Root>
  )
}
```

- `UpdateNotice.Root` renders only while a notice is active and exposes `data-attention` and `data-reason` for styling.
- `UpdateNotice.Refresh` sets `disabled` and `data-refreshing` while a refresh is in flight.
- `UpdateNotice.Close` renders nothing at `urgent`.
- Each part runs your `onClick` before acting, ships no copy or styles, never moves focus, and never closes on a timer.

Pass an `action` prop to `UpdateNotice.Refresh` to customize clicks (for example, confirming before discarding unsaved work). It runs inside a React transition and keeps the button disabled until it settles:

```tsx
<UpdateNotice.Refresh
  action={async refresh => {
    if ((await refresh()) === 'blocked' && confirm('Discard changes?')) {
      flushSync(discardChanges)
      await refresh()
    }
  }}
>
  Refresh
</UpdateNotice.Refresh>
```

Because `useRefreshBlocker` reads the value from the last render, use `flushSync` from `react-dom` before retrying when dirty state lives in React state. Ensure `action` always settles so it does not hold overlapping React transitions pending. A press without `action` starts no transition.

`UpdateNotice.Root` announces updates to screen readers using its required `announcement` prop (return `''` to stay silent).

<details>
<summary>Accessibility, live-region, CSP, and SSR details</summary>

Each `Root` mounts visually hidden `status` and `alert` live regions beside the notice and writes `announcement` copy into the region matching `notice.announce` (`polite` for prompts, `assertive` for urgent) when the notice appears or copy changes.

- **Portals and dialogs:** Because live regions render beside `Root`, notices inside a modal, portal, or other document are announced there. A notice behind an open modal is silent while the page is inert and is not re-announced when the modal closes.
- **Hidden subtrees:** A `Root` with `hidden`, `inert`, or `aria-hidden` stays silent. If hidden by a CSS class instead, return `''` from `announcement` while hidden.
- **Multiple notices:** Two `Root` instances returning copy for the same notice both announce it; return `''` from the secondary one.
- **Strict CSP and SSR:** Visually hidden styles are set from script (no inline `style` attribute needed) and carry `hidden` in server-rendered markup so they take no space before hydration.

</details>

## Refresh and unsaved work

Refresh blockers run synchronously in registration order; any blocker that returns `true` or throws stops the refresh. `useRefreshBlocker(appUpdates.refresh, isDirty)` registers while the component's effects are active. Because React tears down effects inside a hidden React 19.2 `<Activity>`, register blockers for hidden drafts outside `<Activity>` or with `appUpdates.refresh.addBlocker`.

`refresh.run()` resolves with the refresh outcome:

| Outcome     | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `reloading` | `reload` ran and the document is being replaced.         |
| `blocked`   | A refresh blocker stopped it. `reload` was never called. |
| `declined`  | `reload` returned `false` or threw. The error is logged. |

Nothing is stored between calls, so any outcome can be retried, and concurrent calls share one attempt. `refresh.get()` is `true` from when `reload` is called until it settles, and `false` otherwise (never `true` on `blocked`). To let a user override a blocker outside `UpdateNotice.Refresh`, confirm on `'blocked'`, clear the dirty state, and call `appUpdates.refresh.run()` again.

To route reloads through a client-side router, override `reload`:

```ts
import { createAppUpdates } from '@ericchernuka/usher-plugin/client'

export const appUpdates = createAppUpdates({
  reload: () =>
    router.navigate({
      href: window.location.href,
      reloadDocument: true,
      replace: true,
    }),
})
```

Tested against TanStack Router, whose navigation blockers then apply to the reload. Because the router does not report a blocked navigation, `refresh.run()` resolves `'reloading'` either way; use a refresh blocker when your app needs to know, and check dirty state rather than pathname change (both paths match during a reload).

## Trying the flows in development

Enable `usher({ devtools: true })` to simulate deploys from the browser console while `vite` runs:

```js
await __USHER_DEVTOOLS__.deploy() // same as { mode: 'advance' }
await __USHER_DEVTOOLS__.deploy({ mode: 'force' })
await __USHER_DEVTOOLS__.deploy({ mode: 'rollback' })
await __USHER_DEVTOOLS__.deploy({ mode: 'reset' })
```

- `advance` serves a new version built now from the same commit (escalates via your thresholds).
- `force` does the same with a forced-update cutoff covering the running build (`urgent` / `forced`).
- `rollback` serves a version with an earlier commit time (`urgent` / `rollback`).
- `reset` restores the real build facts.

Importing `@ericchernuka/usher-plugin/client` declares the typed `__USHER_DEVTOOLS__` global (possibly `undefined`). Your running app picks up simulated deploys on its next check or window focus; a reloaded page still runs the real build until you call `reset` or restart Vite. Devtools only affect `version.json` (not asset fallback) and are omitted from production builds. The apps under `examples/react/` wire these four modes to buttons: run `pnpm build` once, then `pnpm --filter usher-example-react-cloudflare-pages dev`.

## Testing update UI

`createTestTab()` simulates a browser environment with virtual time. Pass it as the second argument to `createAppUpdates`:

```tsx
import { createAppUpdates } from '@ericchernuka/usher-core'
import { createTestTab } from '@ericchernuka/usher-core/testing'

const tab = createTestTab()
const built = new Date(tab.now()).toISOString()
const running = { version: 'one', commitTime: built, buildTime: built }

const appUpdates = createAppUpdates(
  { running, versionUrl: '/version.json' },
  tab,
)
render(<App appUpdates={appUpdates} />)

tab.deploy({ ...running, version: 'two' })
await tab.advance(5 * 60_000) // five minutes: next check sees the deploy
await tab.advance(12 * 60 * 60_000) // twelve hours: app shows its prompt
```

Before the first `deploy`, the test tab behaves as offline. Its clock starts at real time and moves only via `advance`; leave `setTimeout` unfaked while advancing so async checks can settle. Set `buildTime` to `new Date(tab.now()).toISOString()` on deployed builds to start the outdated clock there, and keep `commitTime` so the deploy is not treated as a rollback.

This recipe uses `@ericchernuka/usher-core` and works in any test runner. To test through `@ericchernuka/usher-plugin/client`, run tests through Vite with `usher()` configured (and inline the plugin in Vitest Node environments):

```ts
// vitest.config.ts
import { usher } from '@ericchernuka/usher-plugin/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [usher()],
  ssr: { noExternal: ['@ericchernuka/usher-plugin'] },
})
```

Then pass `tab` to `createAppUpdates({}, tab)` and deploy `{ ...runningBuild, version: 'next', buildTime: new Date(tab.now()).toISOString() }`.

## Skew protection

Skew protection keeps old content-hashed chunks reachable after a deploy so older running apps can still lazy-load code.

### How skew protection works across hosts

Skew protection is optional because many hosts already support it without an Usher adapter:

| Hosting setup                                       | How old chunks stay reachable                                                                            | What you need from Usher                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Vercel (Skew Protection enabled)**                | Vercel pins older clients to their deployment assets using a deployment ID cookie or header.             | Client packages only (`@ericchernuka/usher-core`, `@ericchernuka/usher-plugin`, `@ericchernuka/react-usher`). |
| **S3 + CloudFront, GCS, or object-storage CDNs**    | CI uploads hashed assets without `--delete`, and a bucket lifecycle rule expires old files after N days. | Client packages only. Keep `index.html` and `version.json` uncached.                                          |
| **Cloudflare Pages and Workers Static Assets**      | Each deploy replaces the full static directory, and SPA fallback returns `index.html` on missing assets. | Client packages plus `@ericchernuka/usher-cloudflare` with an append-only R2 chunk archive.                   |
| **Other hosts that replace static files on deploy** | Old asset URLs miss once a new build goes live.                                                          | Client packages plus a custom `SkewProtectionAdapter` or your own edge fallback for `/assets/`.               |

Paired with `promptAfter`, `urgentAfter`, and `forceUpdateBuiltBefore`, skew protection bounds the age of active clients so your backend API only needs a predictable compatibility window.

### Cloudflare Pages and Workers

Pass an adapter from `@ericchernuka/usher-cloudflare` so the Vite plugin writes the edge files Cloudflare needs:

```ts
import {
  cloudflarePages,
  cloudflareWorkers,
} from '@ericchernuka/usher-cloudflare'

usher({ adapter: cloudflarePages() }) // { r2Binding? }
usher({ adapter: cloudflareWorkers() }) // { r2Binding?, workerFile? }
```

| Adapter               | Writes                                                                                      | You configure                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cloudflarePages()`   | `dist/_worker.js` (Pages advanced mode) and `dist/_routes.json` limited to `<base>assets/*` | An R2 binding on the Pages project. Pages ignores `functions/` once `_worker.js` exists |
| `cloudflareWorkers()` | `dist-worker/index.js` (`.js` or `.mjs`), outside `dist` so it is never served publicly     | `wrangler.jsonc`: `main`, `assets.run_worker_first: ["/assets/*"]`, the R2 binding      |

- **Fallback order:** Serves the current deployment's file first, falls back to R2 on `404` or SPA-fallback HTML, and returns `404` with `Cache-Control: no-store` if neither has the chunk. Requests outside the assets prefix go straight to static assets.
- **Cloudflare Cache Rules:** Exclude `/assets/*` (your assets prefix) from Cache Rules that override browser TTL, or they can strip `no-store` from `404` responses.
- **R2 layout and `base`:** Keys are relative to `base` (matching `aws s3 sync dist/assets s3://<bucket>/assets`), and the R2 binding defaults to `CHUNK_ARCHIVE`. Adapters require an absolute `base` or CDN URL; builds with a relative `base` fail.

For Workers, point Wrangler at the generated entry:

```jsonc
// wrangler.jsonc
{
  "name": "<worker>",
  "main": "dist-worker/index.js",
  "compatibility_date": "<date>",
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

If your app owns its Worker or Pages Functions, omit `adapter` and call `createAssetFallback()` for requests your app does not handle:

```ts
import {
  createAssetFallback,
  type AssetFallbackEnv,
} from '@ericchernuka/usher-cloudflare/worker'

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

Route the assets prefix to the worker (`_routes.json` on Pages or `assets.run_worker_first` on Workers), keep `base` and `assetsDir` aligned with Vite, and name the static assets binding `ASSETS`.

### Deploying with an R2 chunk archive

Upload chunks before deploying, and never delete from the archive during deploy:

```sh
aws s3 sync dist/assets "s3://$BUCKET/assets" \
  --endpoint-url "https://$ACCOUNT_ID.r2.cloudflarestorage.com"   # no --delete
wrangler pages deploy dist   # or: wrangler deploy
```

Pass your R2 endpoint and R2 API token credentials (the `aws` CLI defaults to AWS S3). Uploading first prevents misses during rollout, and omitting `--delete` keeps older running builds working; expire old chunks with an R2 lifecycle rule (such as 30 days). Deploy one Workers version at a time so alternating `version.json` responses during a gradual deploy do not look like a rollback.

## Rollbacks and forced updates

These behaviours work on every host, with or without an Usher adapter.

Dashboard rollbacks and old-commit redeploys are detected automatically through `commitTime` (requires `.git` or `APP_COMMIT_TIME`; the plugin warns if neither exists).

For a forward revert deployed as a new commit, set `APP_FORCE_UPDATE_BUILT_BEFORE` to the fix's build time (`date -u +%Y-%m-%dT%H:%M:%SZ` in CI). Running builds created before that timestamp become urgent immediately. This value is a build time, not a deadline: a timestamp later than the build itself fails the build. Clearing it in a later deploy does not lower urgency in clients that already saw it.

## Monitoring in production

Tag error reports or RUM events with the running build:

```ts
import { runningBuild } from '@ericchernuka/usher-plugin/client'

reportError(error, { version: runningBuild.version })
```

If a deployment breaks `version.json` (a `404`, HTML fallback, bad JSON, or a CSP `connect-src` block), running apps cannot detect updates and `UpdateState` does not expose the failure. Usher logs one console warning per outage; pass `onCheckProblem` to report it:

```ts
export const appUpdates = createAppUpdates({
  onCheckProblem: problem =>
    reportError(new Error(`version.json: ${problem.kind}`), problem),
})
```

| Kind              | Meaning                                                                    | Also carries                          |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| `request-failed`  | Online request failed before any response (for example, CSP `connect-src`) | Nothing more                          |
| `http-error`      | Response was not OK                                                        | `status`                              |
| `not-json`        | Body was not JSON (for example, an HTML fallback)                          | `contentType`, `null` if absent       |
| `not-build-facts` | JSON was the wrong shape                                                   | `issues` (human-readable description) |

- Fires once per outage (and again only after recovery), always including `versionUrl`.
- Ignores offline clients, hidden pages, timeouts, and dropped mid-response connections; filter on `problem.kind` if you want to exclude flaky-network `request-failed` events.
- May be async; throws and rejections are logged without stopping later checks.

## Using Usher without Vite

With another bundler, pass the running build facts and version URL directly to `@ericchernuka/usher-core`:

```ts
import { createAppUpdates } from '@ericchernuka/usher-core'

export const appUpdates = createAppUpdates({
  running: {
    version: 'commit-sha',
    commitTime: '2026-11-11T15:00:00Z',
    buildTime: '2026-11-11T16:00:00Z',
  },
  versionUrl: '/version.json',
})
```

## Reference

### Packages

| Import                                  | What it gives you                                                                              | Needs      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| `@ericchernuka/usher-plugin/vite`       | `usher()`: writes `version.json`, embeds build facts, runs a skew-protection adapter           | Vite 5+    |
| `@ericchernuka/usher-plugin/adapter`    | `SkewProtectionAdapter` and its types, for writing an adapter for another host                 | Nothing    |
| `@ericchernuka/usher-plugin/client`     | `createAppUpdates()` with build facts filled in, and `runningBuild`                            | The plugin |
| `@ericchernuka/react-usher`             | `useUpdateState`, `useRefreshing`, `useRefreshBlocker`, `useUpdateNotice`, `UpdateNotice`      | React 19.2 |
| `@ericchernuka/usher-cloudflare`        | `cloudflarePages()`, `cloudflareWorkers()`: adapters that serve old chunks from R2             | Cloudflare |
| `@ericchernuka/usher-cloudflare/worker` | `createAssetFallback()`: the same handler, for apps that own their Worker                      | Cloudflare |
| `@ericchernuka/usher-core`              | `createAppUpdates(options)`, `connectUpdateSurface()`, `createUpdateNotice()`, with no bundler | Nothing    |
| `@ericchernuka/usher-core/testing`      | `createTestTab()`: a stand-in browser environment with virtual time, for testing update UI     | Nothing    |

### Plugin options

| Plugin option            | Default                                           | Meaning                                                                                                                                   |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `fileName`               | `version.json`                                    | Output file, relative to `outDir` and `base`.                                                                                             |
| `version`                | `APP_VERSION`, `GITHUB_SHA`, then `git rev-parse` | Source version of the build.                                                                                                              |
| `commitTime`             | `APP_COMMIT_TIME`, then `git log`                 | ISO 8601 commit time, used to detect rollbacks.                                                                                           |
| `forceUpdateBuiltBefore` | `APP_FORCE_UPDATE_BUILT_BEFORE`                   | ISO 8601 build time. Clients running a build made before it become urgent. Not a deadline: a value later than this build fails the build. |
| `adapter`                | None                                              | Skew-protection adapter. See [Skew protection](#skew-protection).                                                                         |
| `devtools`               | `false`                                           | Development only. Adds `__USHER_DEVTOOLS__.deploy()` to the page for simulating deploys.                                                  |

### AppUpdates API

```ts
interface AppUpdates {
  state: {
    get(): UpdateState
    subscribe(listener: () => void): () => void
    dismiss(): boolean
  }
  refresh: {
    get(): boolean // whether a refresh is in flight
    subscribe(listener: () => void): () => void
    run(): Promise<'reloading' | 'blocked' | 'declined'>
    addBlocker(blocker: () => boolean): () => void
  }
}
```

Create one instance per `storageKey` in a document (browsers fire `storage` events only in other documents). `state.get()` keeps the same object reference until `attention`, `reason`, or `latest` changes. `state.dismiss()` returns `true` only when it lowers a prompt; otherwise it returns `false` and writes nothing. `state` and `refresh` have independent subscriptions.

### createAppUpdates options

Durations are in milliseconds (for example, `4 * 60 * 60_000` for 4 hours). Invalid options throw at creation with a message naming the option.

| Option           | Default                            | Meaning                                                                                                                  |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `running`        | Required by core; set by `/client` | Build facts of the running build (`version`, `commitTime`, `buildTime`, optional `forceUpdateBuiltBefore`).              |
| `versionUrl`     | Required by core; set by `/client` | The serving deployment's `version.json` URL.                                                                             |
| `promptAfter`    | 12 hours                           | Time outdated at which a running app reaches prompt attention. `false` disables this level.                              |
| `urgentAfter`    | 24 hours                           | Time outdated at which it reaches urgent attention. `false` disables this level. Must exceed `promptAfter`.              |
| `promptSnooze`   | Until urgent attention starts      | Duration for which a prompt dismissal quiets prompt attention.                                                           |
| `pollInterval`   | 5 minutes                          | How often a visible page checks (at least 10 seconds). Focus and visibility changes also check, at most once per minute. |
| `reload`         | `location.reload()`                | Document load performed by a refresh. Return or resolve `false` when you know it did not happen.                         |
| `onCheckProblem` | None                               | Called on a deployment-fixable check problem. See [Monitoring in production](#monitoring-in-production).                 |
| `storageKey`     | `usher`                            | Prefix for `localStorage` keys (such as `usher:prompt-dismissal`). Set one per app when apps share an origin.            |

Time outdated and dismissals use the server's clock from each `version.json` response's `Date` header. When serving `version.json` cross-origin, expose it with `Access-Control-Expose-Headers: Date`; otherwise Usher falls back to the local clock.

## Further reading

- [Glossary](GLOSSARY.md): domain terms used across Usher.
- [Architecture](docs/Skew%20protection%20architecture.md): package ownership, internal modules, request handling, and deployment.
- [Contributing](CONTRIBUTING.md): local setup (`pnpm install && pnpm build && pnpm check`), workspace scripts, Playwright setup, and Changesets releases.

## License

[MIT](LICENSE)
