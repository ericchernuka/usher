# Usher

Usher keeps running single-page apps working across deployments and guides users onto the latest build with minimal disruption.

It combines two independent pieces:

1. **Calm, escalating update prompts** that work with any hosting provider, respect unsaved work, and escalate only when a running build falls far behind or hits a rollback or forced update.
2. **Optional skew protection** that keeps previously shipped JS and CSS chunks reachable on hosts that replace static files on deploy, so older running builds never break and users are never reloaded by force.

**Contents:** [Why Usher?](#why-usher) · [Quick start](#quick-start) · [Update state](#update-state) · [Showing update UI](#showing-update-ui) · [Refresh and unsaved work](#refresh-and-unsaved-work) · [Development](#trying-the-flows-in-development) · [Testing](#testing-update-ui) · [Skew protection](#skew-protection) · [Rollbacks & forced updates](#rollbacks-and-forced-updates) · [Monitoring](#monitoring-in-production) · [Without Vite](#using-usher-without-vite) · [Reference](#reference)

## Why Usher?

When you deploy a new build of a single-page app, users who already loaded the app keep running the previous build in memory. That happens with any client older than the latest deployment: a browser session opened minutes before a deploy, an installed PWA, an Electron window, or a mobile WebView.

As that running app navigates to a lazy-loaded route or modal, it requests code-split chunks using the old content hashes. On hosts that overwrite the static directory on every deploy, those requests miss and return a `404` or an SPA fallback `index.html` with a `200` status. The browser then fails the import. Many apps work around this by forcing a hard reload on navigation or chunk errors, which discards unsaved forms and interrupts the user.

Usher takes a different approach:

- **Keep older running builds working** through skew protection (either your host's built-in support or an Usher adapter).
- **Ask users to refresh calmly** as their running build gets outdated, and block refreshes while they have unsaved work.
- **Escalate when it matters**, jumping straight to an urgent, non-dismissible notice on rollbacks, forced updates, or once a running app has been outdated past your limit.

Usher never reloads on navigation, on a chunk error, or on its own timer. The app refreshes only when your code calls `refresh.run()`.

## Quick start

> **Requirements:** Vite 5+ for `@ericchernuka/usher-plugin`, and React 19.2+ for `@ericchernuka/react-usher`. For other bundlers, see [Using Usher without Vite](#using-usher-without-vite).

Install the core package and the Vite plugin, plus React hooks or Cloudflare skew protection if your app uses them:

```sh
pnpm add @ericchernuka/usher-core
pnpm add -D @ericchernuka/usher-plugin

# Optional: React hooks and headless notice components
pnpm add @ericchernuka/react-usher

# Optional: Skew protection on Cloudflare Pages or Workers
pnpm add -D @ericchernuka/usher-cloudflare
```

> `@ericchernuka/usher-core` is a peer dependency of the plugin and the React package, so your app installs it once and every package shares that single copy.

Add the plugin to Vite:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { usher } from '@ericchernuka/usher-plugin/vite'

export default defineConfig({ plugins: [react(), usher()] })
```

Create one `appUpdates` instance at module scope. Creating it has no side effects: `appUpdates.state` checks for a new build only while it has at least one subscriber and stops after the last subscriber leaves.

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

Each hook subscribes only to the piece you pass it (`appUpdates.state` or `appUpdates.refresh`):

- `useUpdateState` returns the full update state and defers updates so state changes render at low priority and never interrupt typing.
- `useRefreshing` returns `true` while a refresh is in flight (useful when reloads go through a router) and does not start version checks on its own.
- `useRefreshBlocker` accepts a boolean or a callback; an inline function is safe because the hook registers once and always calls the latest callback.

### Required cache headers

Serve `version.json` uncached. The client also adds a `t` query parameter to each check. On Cloudflare Pages and Workers static assets, add this to `public/_headers`:

```
/version.json
  Cache-Control: no-store
```

Do not cache `index.html` at the edge either. A refresh must load the latest build's HTML document, so serve it with `Cache-Control: no-cache` or your host's default.

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

Every state except `unknown` includes `latest`, the build metadata (called `BuildFacts` in Usher) reported by the server.

A running app counts as outdated from the build time of the first newer build it sees, not from the age of its own build. An app loaded a minute ago on last week's build is one minute outdated when the next deploy lands, so it starts `passive`. Later deploys do not restart the clock, so a team that deploys a hundred times a day and a team that deploys once a week both prompt after 12 hours outdated and turn urgent after 24. If the running app catches up (for example, after a rollback back to its build), the clock resets.

Rollback and forced-update urgency persists until the app reloads, even if a later response reports the running version again. A forced-update cutoff applies even when the version matches. Urgent attention cannot be dismissed.

A prompt dismissal records its server timestamp in `localStorage`. It quiets every open window or tab on the same origin whose prompt threshold had already started, until each reaches urgent attention. A running build that reaches its prompt threshold later can still prompt. `promptSnooze` sets a shorter or longer quiet period, though it never quiets urgent attention. With `urgentAfter: false` and no `promptSnooze`, a dismissed prompt stays dismissed.

## Showing update UI

Choose the integration that fits your UI stack:

- **Already use an imperative toast or banner library (such as Sonner or your design system's toaster)?** Use `connectUpdateSurface` from `@ericchernuka/usher-core`.
- **Building a custom banner or toast in React?** Use the headless `UpdateNotice` components (or `useUpdateNotice`) from `@ericchernuka/react-usher`.
- **Want raw state for a nav indicator or custom logic?** Use `useUpdateState` and `useRefreshing`, as shown in [Quick start](#quick-start).

### Connecting a toast or banner library

`connectUpdateSurface` drives an imperative toast or banner library from your `appUpdates` instance:

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

`show` runs once per change of attention or reason, receiving a new notice each time. Your surface owns its toast ID and copy. The default minimum attention is `prompt`; pass `minAttention: 'passive'` for a persistent update banner.

`notice.close()` signals that the user closed the surface:

- **At `prompt`:** dismisses the prompt across all open tabs on that origin and calls `hide()`.
- **At `passive`:** calls `hide()` and stays hidden until attention or reason changes. A notice created via `createUpdateNotice` or the React components stays hidden while subscribed; if its last subscriber leaves and later returns (such as inside a hidden React 19.2 `<Activity>` boundary), it stays hidden only if the update state did not change in between.
- **At `urgent`:** calls `show()` again with a new notice, because urgent attention cannot be dismissed and some toast libraries remove a toast on close anyway. Outside `connectUpdateSurface`, closing an urgent notice is a no-op.

Important lifecycle details:

- **Safe programmatic close:** A notice that is no longer active ignores `close()`, so toast libraries that fire `onClose` during `hide()` are safe.
- **No auto-dismiss timers on urgent notices:** A toast library that auto-dismisses urgent notices on a timer causes `connectUpdateSurface` to re-show it; after five re-shows in one pass, it stops and logs an error.
- **Error handling and cleanup:** `disconnect()` hides the surface and removes its subscription. If `show` throws, Usher logs the error, drops the notice, and retries on the next state change. If `hide` throws, Usher logs it once and does not retry.
- **Notice metadata:** Each notice carries `latest` (the latest build metadata when the notice was created; read `appUpdates.state` for the current build), `closable` (`false` at `urgent`), and `announce` (`'off'` at `passive`, `'polite'` at `prompt`, `'assertive'` at `urgent`), which you can forward to a toast library's live region.

### Headless React components

Components that render their own markup can read the same notice, with the same close rules, from `useUpdateNotice(appUpdates, { minAttention })`. For the common case, `@ericchernuka/react-usher` provides headless compound components:

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

- `UpdateNotice.Root` renders only while a notice is active and exposes `data-attention` and `data-reason` attributes for styling.
- `UpdateNotice.Refresh` sets `disabled` and `data-refreshing` while a refresh is in flight.
- `UpdateNotice.Close` renders nothing at `urgent`.
- Each part runs your own `onClick` handler before acting. The components ship no copy or styles, never steal focus, and never close on a timer.

To customize what happens when a user clicks `Refresh` (for example, prompting to confirm discarding unsaved changes), pass an `action` prop. It receives the `refresh` function and runs inside a React transition, keeping the button disabled until the action settles:

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

Because `useRefreshBlocker` reads the value from the last render, use `flushSync` from `react-dom` before retrying when your dirty state lives in React state. Otherwise, the second `refresh()` sees the old value and is blocked again. Ensure your `action` always settles: React holds overlapping transitions in the same root pending until all Actions resolve. A press without an `action` prop does not start a transition.

`UpdateNotice.Root` announces updates to screen readers using the string returned by its required `announcement` prop (return `''` to suppress announcements).

<details>
<summary>Accessibility, live-region, CSP, and SSR details</summary>

Each `Root` mounts visually hidden `status` and `alert` live regions beside the notice before there is anything to say. It writes the announcement copy into the region that matches `notice.announce`, so screen readers announce prompts politely and urgent notices assertively when the notice appears and whenever the copy changes.

- **Portals and dialogs:** Because the live regions render beside `Root`, a notice inside a modal dialog, portal, or another document is announced in that context. A notice behind an open modal dialog is silent while the page is inert and is not re-announced when the dialog closes.
- **Hidden subtrees:** A `Root` with `hidden`, `inert`, or `aria-hidden` stays silent. If you hide a `Root` via CSS classes instead, return an empty string from `announcement` while hidden.
- **Multiple notices:** Two `Root` instances that both return copy for the same notice will both announce it. Provide copy on one and return `''` from the other.
- **Strict CSP and SSR:** The live regions apply visually hidden styles from script (no inline `style` attribute required for strict Content Security Policies) and carry `hidden` in server-rendered markup so they take no space before hydration.
- **Explicit copy:** `announcement` is required because only your app knows which text is the message rather than decorative labels or controls.

</details>

## Refresh and unsaved work

Refresh blockers decide whether a refresh can proceed. They run synchronously in registration order, and any blocker that returns `true` or throws stops the refresh. In React, `useRefreshBlocker(appUpdates.refresh, isDirty)` registers a blocker while the component's effects are active. Because React tears down effects inside a hidden React 19.2 `<Activity>` boundary, register blockers for hidden drafts outside `<Activity>` or directly with `appUpdates.refresh.addBlocker`.

`refresh.run()` resolves with the outcome:

| Outcome     | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `reloading` | `reload` ran and the document is being replaced.         |
| `blocked`   | A refresh blocker stopped it. `reload` was never called. |
| `declined`  | `reload` returned `false` or threw. The error is logged. |

Nothing is stored between calls, so any outcome can be retried, and concurrent calls share one attempt. `refresh.get()` is `true` from the moment `reload` is called until it settles, and `false` again after every outcome; a blocked refresh never sets it to `true`.

To let users override a blocker, confirm on `blocked`, clear the dirty state, and call `refresh.run()` again:

```ts
if (
  (await appUpdates.refresh.run()) === 'blocked' &&
  confirm('Discard changes?')
) {
  discardChanges() // the blocker now returns false
  await appUpdates.refresh.run()
}
```

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

This recipe is tested against TanStack Router, whose own navigation blockers then apply to the reload. Because the router does not report a blocked navigation, `refresh.run()` resolves `reloading` either way; use a refresh blocker when your app needs to know. During a refresh the current and next paths match, so a router blocker must check dirty state rather than a pathname change.

## Trying the flows in development

You do not need real deployments to test update prompts, rollbacks, or forced updates. Enable `usher({ devtools: true })` to simulate deploys from the browser console while `vite` runs:

```js
await __USHER_DEVTOOLS__.deploy() // same as { mode: 'advance' }
await __USHER_DEVTOOLS__.deploy({ mode: 'force' })
await __USHER_DEVTOOLS__.deploy({ mode: 'rollback' })
await __USHER_DEVTOOLS__.deploy({ mode: 'reset' })
```

Importing `@ericchernuka/usher-plugin/client` declares the `__USHER_DEVTOOLS__` global (typed as possibly `undefined`) so app code can guard calls safely. The example apps under `examples/react/` wire these four modes to buttons alongside live update state, an update notice, and a dirty draft blocker. Run `pnpm build` once, then start an example with `pnpm --filter usher-example-react-cloudflare-pages dev`.

The dev server serves simulated build metadata from the version URL while your app continues running the real build:

- `advance` serves a new version built now from the same commit. Your running app becomes outdated, and attention follows your thresholds counted from now.
- `force` does the same with a forced-update cutoff that covers the real build. Attention becomes `urgent` with reason `forced`.
- `rollback` serves a new version whose commit time is earlier than the real one. Attention becomes `urgent` with reason `rollback`.
- `reset` serves the real build metadata again.

The promise resolves with the served build metadata once the server updates. Your running app notices on its next check or when the page regains focus. Forced-update and rollback urgency stay active until reload, matching production. A freshly reloaded page still runs the real build, so it stays outdated until you call `reset` or restart Vite. Devtools only change `version.json` and do not exercise asset fallback. Production builds contain neither the global nor the endpoint.

## Testing update UI

`createTestTab()` simulates a browser tab with virtual time. Pass it as the second argument to `createAppUpdates`:

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
await tab.advance(5 * 60_000) // five minutes: the next check sees the deploy
await tab.advance(12 * 60 * 60_000) // twelve hours
// the app now shows its prompt
```

`deploy` sets the build metadata returned by every version check, and `advance` moves virtual time forward, running due checks and timers. Before the first `deploy`, the test tab behaves as offline. Its clock starts at real time and moves only when advanced. Leave `setTimeout` unfaked while advancing, because the test tab uses real timers to settle async checks.

Because an app counts as outdated from the build time of the newer build, set `buildTime` to `new Date(tab.now()).toISOString()` on deployed builds to start the clock there, and keep the running build's `commitTime` so the deploy is not treated as a rollback.

The recipe above uses `@ericchernuka/usher-core` directly, so it works in any test runner. To test through `@ericchernuka/usher-plugin/client`, your test runner must run through Vite with `usher()` configured (so the virtual build metadata module is available). Vitest's browser mode needs nothing else; in Vitest's Node environments, also inline the plugin package through Vite:

```ts
// vitest.config.ts
import { usher } from '@ericchernuka/usher-plugin/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [usher()],
  ssr: { noExternal: ['@ericchernuka/usher-plugin'] },
})
```

```tsx
import { createTestTab } from '@ericchernuka/usher-core/testing'
import {
  createAppUpdates,
  runningBuild,
} from '@ericchernuka/usher-plugin/client'

const tab = createTestTab()
const appUpdates = createAppUpdates({}, tab)
render(<App appUpdates={appUpdates} />)

tab.deploy({
  ...runningBuild,
  version: 'next',
  buildTime: new Date(tab.now()).toISOString(),
})
await tab.advance(5 * 60_000)
await tab.advance(12 * 60 * 60_000)
```

## Skew protection

Skew protection keeps old content-hashed chunks reachable after a deployment so running apps on older builds do not fail when lazy-loading code.

### How skew protection works across hosts

Skew protection is optional in Usher because many hosts already provide it or let you configure it without an edge adapter:

| Hosting setup                                       | How old chunks stay reachable                                                                            | What you need from Usher                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Vercel (Skew Protection enabled)**                | Vercel pins older clients to their deployment assets using a deployment ID cookie or header.             | Client packages only (`@ericchernuka/usher-core`, `@ericchernuka/usher-plugin`, `@ericchernuka/react-usher`). |
| **S3 + CloudFront, GCS, or object-storage CDNs**    | CI uploads hashed assets without `--delete`, and a bucket lifecycle rule expires old files after N days. | Client packages only. Keep `index.html` and `version.json` uncached.                                          |
| **Cloudflare Pages and Workers Static Assets**      | Each deploy replaces the full static directory, and SPA fallback returns `index.html` on missing assets. | Client packages plus `@ericchernuka/usher-cloudflare` (with an append-only R2 chunk archive).                 |
| **Other hosts that replace static files on deploy** | Old asset URLs miss once a new build goes live.                                                          | Client packages plus a custom `SkewProtectionAdapter` or your own edge fallback for `/assets/`.               |

Asset skew protection keeps older frontend builds loading their JS and CSS chunks. Usher's `promptAfter` and `urgentAfter` thresholds (12 hours and 24 hours by default) plus `forceUpdateBuiltBefore` keep the age of active clients bounded, so your backend API only needs a predictable compatibility window.

### Cloudflare Pages and Workers

Pass an adapter from `@ericchernuka/usher-cloudflare`, and the Vite plugin writes the edge files Cloudflare needs:

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

How the generated worker behaves:

- **Fallback order:** Serves the current deployment's static file first, falls back to R2 on a `404` or an SPA-fallback HTML response, and returns a real `404` with `Cache-Control: no-store` when neither has the chunk (so browsers do not cache a transient miss). Requests outside the assets prefix go straight to static assets.
- **Cloudflare Cache Rules:** Exclude your assets prefix (`/assets/*` by default) from any Cloudflare Cache Rule that overrides browser TTL, or it can replace the `no-store` header on `404` responses.
- **R2 layout and binding:** Keys are paths relative to `base` (matching `aws s3 sync dist/assets s3://<bucket>/assets` in CI). The R2 binding defaults to `CHUNK_ARCHIVE`.
- **Vite `base` requirement:** An adapter requires an absolute `base` or a CDN URL; builds with a relative `base` fail because chunks have no fixed path to route.

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

If your app owns its Worker or Pages Functions, omit the `adapter` option and call `createAssetFallback()` for requests your app does not handle itself:

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

Your app then owns its routing: `_routes.json` on Pages, or `assets.run_worker_first` on Workers, must route the assets prefix to the worker. Keep `base` and `assetsDir` aligned with your Vite config. The handler requires the static assets binding named `ASSETS`.

### Deploying with an R2 chunk archive

Upload chunks before the deployment that references them goes live, and never delete from the archive during a deploy:

```sh
aws s3 sync dist/assets "s3://$BUCKET/assets" \
  --endpoint-url "https://$ACCOUNT_ID.r2.cloudflarestorage.com"   # no --delete
wrangler pages deploy dist   # or: wrangler deploy
```

Because the `aws` CLI defaults to AWS S3, pass R2's endpoint as shown above (or in your AWS profile). `$ACCOUNT_ID` is your Cloudflare account ID, and credentials come from an R2 API token.

Uploading first ensures a client that loads the new `index.html` right as the deploy switches over can already fall back to R2. Omitting `--delete` is what keeps older running builds working; expire old chunks with an R2 lifecycle rule (for example, 30 days) instead.

Deploy one Workers version at a time. Alternating `version.json` responses during a gradual deployment can look like a rollback. R2 continues serving chunks for clients on a bad build until their users refresh.

## Rollbacks and forced updates

These behaviors work on every hosting provider, with or without an Usher adapter.

Dashboard rollbacks and old-commit redeploys are detected automatically through `commitTime`. Your build needs `.git` or `APP_COMMIT_TIME`; the plugin logs a warning when neither is present.

For a forward revert deployed as a new commit, set `APP_FORCE_UPDATE_BUILT_BEFORE` to the build time of the fix (`date -u +%Y-%m-%dT%H:%M:%SZ` in the deploy job). Every client running a build created before that timestamp becomes urgent immediately. This value is a build time, not a deadline: a timestamp later than the build itself fails the build because no refresh could ever satisfy it. Clearing `APP_FORCE_UPDATE_BUILT_BEFORE` in a later deploy does not lower urgency in clients that already observed it.

## Monitoring in production

### Identifying the running build

To tag error reports or RUM events with the build currently running in the browser, import `runningBuild`:

```ts
import { runningBuild } from '@ericchernuka/usher-plugin/client'

reportError(error, { version: runningBuild.version })
```

### Handling version file problems

A version check can fail to get valid build metadata because of a deployment issue: a `404`, an HTML fallback response, malformed JSON, or a Content Security Policy `connect-src` rule blocking the request. Until fixed, running apps on that deployment cannot detect updates, and nothing in `UpdateState` exposes the error. Usher logs one console warning per outage; pass `onCheckProblem` to report it to your monitoring tool as well:

```ts
export const appUpdates = createAppUpdates({
  onCheckProblem: problem =>
    reportError(new Error(`version.json: ${problem.kind}`), problem),
})
```

| Kind              | Meaning                                                                                                  | Also carries                          |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `request-failed`  | The browser was online, but the request failed before any response, as when CSP `connect-src` blocks it. | Nothing more                          |
| `http-error`      | The response was not OK.                                                                                 | `status`                              |
| `not-json`        | The body was not JSON, as when a host answers with its HTML fallback.                                    | `contentType`, `null` if absent       |
| `not-build-facts` | The JSON was the wrong shape.                                                                            | `issues` (human-readable description) |

How `onCheckProblem` behaves:

- **Deduplicated per outage:** Fires once when a problem starts, and again only if `version.json` recovers and breaks later. Every problem object also includes `versionUrl`.
- **Ignores normal client noise:** Offline clients, hidden tabs, timeouts, and mid-response dropped connections do not call `onCheckProblem`. A flaky connection that the browser still considers online can emit `request-failed`, so filter on `problem.kind` if you only want configuration errors.
- **Safe async handlers:** `onCheckProblem` may be async; thrown errors or rejected promises are logged and do not interrupt future checks.

## Using Usher without Vite

With another bundler, pass the running build metadata and version URL directly to `@ericchernuka/usher-core`:

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

| Import                                  | What it gives you                                                                                     | Needs      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| `@ericchernuka/usher-plugin/vite`       | `usher()`: writes `version.json`, embeds build metadata, runs a skew-protection adapter               | Vite 5+    |
| `@ericchernuka/usher-plugin/adapter`    | `SkewProtectionAdapter` and its types, for writing an adapter for another host                        | Nothing    |
| `@ericchernuka/usher-plugin/client`     | `createAppUpdates()` with build metadata filled in, and `runningBuild`                                | The plugin |
| `@ericchernuka/react-usher`             | `useUpdateState`, `useRefreshing`, `useRefreshBlocker`, `useUpdateNotice`, `UpdateNotice`             | React 19.2 |
| `@ericchernuka/usher-cloudflare`        | `cloudflarePages()`, `cloudflareWorkers()`: adapters that serve old chunks from R2                    | Cloudflare |
| `@ericchernuka/usher-cloudflare/worker` | `createAssetFallback()`: the same handler, for apps that own their Worker                             | Cloudflare |
| `@ericchernuka/usher-core`              | `createAppUpdates(options)`, `connectUpdateSurface()`, and `createUpdateNotice()`, with no build tool | Nothing    |
| `@ericchernuka/usher-core/testing`      | `createTestTab()`: a fake browser tab with virtual time, for testing update UI                        | Nothing    |

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

type UpdateState =
  | { attention: 'none'; reason: 'unknown'; latest?: undefined }
  | { attention: 'none'; reason: 'caught-up'; latest: BuildFacts }
  | {
      attention: 'passive'
      reason: 'outdated' | 'dismissed'
      latest: BuildFacts
    }
  | { attention: 'prompt'; reason: 'outdated'; latest: BuildFacts }
  | {
      attention: 'urgent'
      reason: 'outdated' | 'rollback' | 'forced'
      latest: BuildFacts
    }

interface BuildFacts {
  version: string
  commitTime: string
  buildTime: string
  forceUpdateBuiltBefore?: string
}
```

Create one instance per `storageKey` in a document. Two instances sharing a key in the same document do not hear each other's dismissals because browsers fire `storage` events only in other documents.

`state.get()` returns the same object reference until attention, reason, or any field in `latest` changes. `state.dismiss()` returns `true` only when it lowers a prompt; otherwise it returns `false` and writes nothing. `state` and `refresh` have independent subscriptions, so a listener on `state` hears update state changes and a listener on `refresh` hears when a refresh starts and ends.

### createAppUpdates options

Durations are in milliseconds so they can be computed directly:

```ts
import { createAppUpdates } from '@ericchernuka/usher-plugin/client'

const HOUR = 60 * 60 * 1000

export const appUpdates = createAppUpdates({
  promptAfter: 4 * HOUR,
  urgentAfter: 12 * HOUR,
})
```

| Option           | Default                            | Meaning                                                                                                                                                           |
| ---------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`        | Required by core; set by `/client` | Build metadata of the running build.                                                                                                                              |
| `versionUrl`     | Required by core; set by `/client` | The serving deployment's `version.json` URL.                                                                                                                      |
| `promptAfter`    | 12 hours                           | Time outdated at which a running app reaches prompt attention. `false` turns the level off.                                                                       |
| `urgentAfter`    | 24 hours                           | Time outdated at which it reaches urgent attention. `false` turns the level off. Must be later than `promptAfter`.                                                |
| `promptSnooze`   | Until urgent attention starts      | How long a prompt dismissal quiets prompt attention.                                                                                                              |
| `pollInterval`   | 5 minutes                          | How often a visible page checks, at least 10 seconds. Focus and visibility changes also trigger a check, at most once a minute.                                   |
| `reload`         | `location.reload()`                | Document load performed by a refresh. Return or resolve `false` when you know it did not happen.                                                                  |
| `onCheckProblem` | None                               | Called when a version check cannot get build metadata for a reason the deployment can fix. See [Handling version file problems](#handling-version-file-problems). |
| `storageKey`     | `usher`                            | Prefix for keys Usher writes to `localStorage`, such as `usher:prompt-dismissal`. Set one per app when apps share an origin.                                      |

Invalid options throw at creation, with a message naming the option.

Time outdated and dismissals are measured against the server's clock, read from the `Date` header of each `version.json` response. If `version.json` is served from another origin, include `Access-Control-Expose-Headers: Date`; without it, the client falls back to the user's local clock.

## Further reading

- [Glossary](GLOSSARY.md): definitions of Usher's domain terms.
- [Architecture](docs/Skew%20protection%20architecture.md): package ownership, internal modules, request handling, and deployment.

## Contributing

Usher is a pnpm workspace managed by Turbo. To work on it locally:

```sh
pnpm install
pnpm build
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full list of scripts, Playwright browser setup, and the Changesets release process.

## License

[MIT](LICENSE)
