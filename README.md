# Usher

Usher keeps running single-page apps working across deployments and guides users onto the latest build with minimal disruption.

It combines two independent pieces:

1. **Calm, escalating update prompts** that work with any hosting provider, respect unsaved work, and escalate only when a running build falls far behind or hits a rollback or forced update.
2. **Optional skew protection** that keeps previously shipped JS and CSS chunks reachable on hosts that replace static files on deploy, so older running builds never break and users are never reloaded by force.

The [glossary](GLOSSARY.md) defines the domain terms. The [architecture document](docs/Skew%20protection%20architecture.md) covers package ownership, internal modules, request handling, and deployment.

## Why Usher?

When you deploy a new build of a single-page app, users who already loaded the app keep running the previous build in memory. That happens with any client older than the latest deployment: a browser session opened minutes before a deploy, an installed PWA, an Electron window, or a mobile WebView.

As that running app navigates to a lazy-loaded route or modal, it requests code-split chunks using the old content hashes. On hosts that overwrite the static directory on every deploy, those requests miss and return a `404` or an SPA fallback `index.html` with a `200` status. The browser then fails the import. Many apps work around this by forcing a hard reload on navigation or chunk errors, which discards unsaved forms and interrupts the user.

Usher takes a different approach:

- **Keep older running builds working** through skew protection (either your host's built-in support or an Usher adapter).
- **Ask users to refresh calmly** as their running build gets outdated, and block refreshes while they have unsaved work.
- **Escalate when it matters**, jumping straight to an urgent, non-dismissible notice on rollbacks, forced updates, or once a running app has been outdated past your limit.

Usher never reloads on navigation, on a chunk error, or on its own timer. The app refreshes only when your code calls `refresh.run()`.

## Quick start

Install the core package and the Vite plugin, plus React hooks and Cloudflare skew protection if your app uses them:

```sh
pnpm add @ericchernuka/usher-core
pnpm add -D @ericchernuka/usher-plugin
pnpm add @ericchernuka/react-usher          # React hooks
pnpm add -D @ericchernuka/usher-cloudflare  # Skew protection on Cloudflare Pages or Workers
```

> `@ericchernuka/usher-core` is a peer dependency of the plugin and the React package, so your app installs it once and every package shares that copy. Your app also imports `connectUpdateSurface` and the types from it.

Add the plugin to Vite:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { usher } from '@ericchernuka/usher-plugin/vite'

export default defineConfig({ plugins: [react(), usher()] })
```

Create the app's updates once at module scope. Creating them has no side effects: `appUpdates.state` checks for a new build while it has at least one subscriber and stops after the last one leaves.

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
  const form = useForm()
  useRefreshBlocker(appUpdates.refresh, form.formState.isDirty)

  return <form>{/* ... */}</form>
}
```

Each hook takes the behaviour it reads. `useUpdateState` returns the full state and defers it, so a new state renders at low priority and never interrupts typing. Read the fields you need from it. `useRefreshing` is `true` while a refresh is in flight, which matters when the reload goes through a router and takes time. Reading it does not start version checks. `useRefreshBlocker` accepts a boolean or a function; an inline function is safe because the hook registers once and always calls the latest one.

To tag error reports or RUM events with the running build, import its facts:

```ts
import { runningBuild } from '@ericchernuka/usher-plugin/client'

reportError(error, { version: runningBuild.version })
```

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

Every state except `unknown` carries `latest`, the build facts reported by the server.

A running app counts as outdated from the build time of the first newer build it sees, not from the age of its own build. An app loaded a minute ago on last week's build is one minute outdated when the next deploy lands, so it starts `passive`. Later deploys do not restart the clock, so a team that deploys a hundred times a day and a team that deploys once a week both prompt after 12 hours outdated and turn urgent after 24. If the running app catches up, such as after a rollback back to its build, the clock resets.

Rollback and forced-update knowledge stays urgent until the app reloads, even if a later response reports the running version again. A forced-update cutoff applies even when the version matches. Urgent attention cannot be dismissed.

A prompt dismissal records its server timestamp in `localStorage`. It quiets every open window or tab on the same origin whose prompt threshold had already started, until each reaches urgent attention. A running build that reaches its prompt threshold later can still prompt. `promptSnooze` sets a shorter or longer quiet period, though it never quiets urgent attention. With `urgentAfter: false` and no `promptSnooze`, a dismissed prompt stays dismissed.

## Update surfaces

`connectUpdateSurface` drives an imperative toast or banner library from the app's updates:

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

- For a `prompt` notice, it dismisses the prompt for every open window or tab on that origin and calls `hide()`.
- For a `passive` notice, it calls `hide()` and stays hidden until attention or reason changes. A notice read with `createUpdateNotice` or the React parts keeps that close while it has a reader. If its last reader leaves and returns, as inside a hidden `<Activity>`, the close is kept only if the update state did not change in between.
- For an `urgent` notice, it calls `show()` again with a new notice, because urgent attention cannot be closed and some toast libraries remove a toast anyway. Outside `connectUpdateSurface`, closing an urgent notice does nothing.

A notice that is no longer the active one ignores `close()`, so libraries that fire `onClose` during a programmatic `hide()` are safe.

Give urgent notices no auto-dismiss timeout. A toast library that closes an urgent notice on a timer causes `connectUpdateSurface` to re-show it, and after five such rounds in one pass it stops and logs an error.

`disconnect()` hides the surface and removes its subscription. A `show` that throws is logged, its notice is dropped, and it is retried on the next state change. A `hide` that throws is logged and not repeated.

A notice's `latest` is the build that was latest when the notice was made. A notice is replaced when attention or reason changes, and when an urgent one is shown again; read the update state for the current build. Every notice also carries `closable`, which is `false` at urgent, and `announce`, which says how a screen reader should hear it: `off` at passive, `polite` at prompt, `assertive` at urgent. Pass `announce` to a toast library that owns its live region.

### A notice in React

A component that renders its own markup reads the same notice, with the same close rules, from `useUpdateNotice(appUpdates, { minAttention })`. The headless parts cover the common case:

```tsx
import { UpdateNotice } from '@ericchernuka/react-usher'

;<UpdateNotice.Root
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
```

`Root` renders its element only while there is a notice, with `data-attention` and `data-reason` for styling. `Refresh` is disabled, with `data-refreshing`, while a refresh is in flight. `Close` renders nothing at urgent. A part's own `onClick` runs before the part acts. The parts ship no copy and no styles, never move focus, and never close on a timer.

To decide what a press on `Refresh` does, give it an `action`. It receives the refresh to call and runs in a transition, as React's Action props do, and the button stays disabled until it settles:

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

`useRefreshBlocker` reads the value from the last render, so when the draft lives in React state the retry has to wait for that state to be committed. `flushSync` from `react-dom` does that. Without it the second `refresh()` sees the old value and is blocked again.

An action has to settle. React keeps overlapping transitions in the same root pending until all their Actions complete, so one that never resolves holds the app's other pending states too. A press without an `action` starts no transition.

`Root` announces the notice with the copy its `announcement` prop returns. The prop is required, and an empty string announces nothing.

Each `Root` keeps a `status` and an `alert` region of its own beside the notice, visually hidden and present before there is anything to say. It puts the copy into the one that matches `announce`, so a screen reader hears a prompt politely and an urgent notice assertively, when the notice appears and again when the copy changes. Because the regions sit where the `Root` is rendered, a notice inside a modal dialog, a portal, or another document is announced there. A `Root` given `hidden`, `inert`, or `aria-hidden` stays silent. If a `Root` is hidden some other way, such as by a class, give it an empty string while it is. A notice on the page behind an open modal dialog is not heard while the dialog is open, since the page is inert then, and is not said again when it closes. The regions are hidden with styles set from script, so they need no inline style attribute and work under a strict Content Security Policy. In server-rendered markup they carry `hidden` until then, so they take no space before the page hydrates. Two `Root`s that give copy for the same notice both announce it, so give the copy to one and an empty string to the other. The copy is the app's to give because only the app knows which of its text is the message: reading it back out of the markup means guessing what is hidden, decorative, or a control.

## Refresh and unsaved work

Refresh blockers decide whether a refresh can proceed. They run synchronously in registration order, and any blocker that returns `true` or throws stops the refresh. In React, `useRefreshBlocker(appUpdates.refresh, isDirty)` registers a blocker while the component's effects are active. React removes the effects of a component inside a hidden `<Activity>`, so a draft that should block while hidden needs its blocker registered outside that boundary, or with `appUpdates.refresh.addBlocker`.

`refresh.run()` resolves with the outcome:

| Outcome     | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `reloading` | `reload` ran and the document is being replaced.         |
| `blocked`   | A refresh blocker stopped it. `reload` was never called. |
| `declined`  | `reload` returned `false` or threw. The error is logged. |

Nothing is stored between calls, so any outcome can be retried, and concurrent calls share one attempt. `refresh.get()` is `true` from the moment `reload` is called until it settles, and `false` again after every outcome. A blocked refresh never makes it `true`. To let the user override a blocker, confirm on `blocked`, clear the dirty state, and call `refresh.run()` again:

```ts
if (
  (await appUpdates.refresh.run()) === 'blocked' &&
  confirm('Discard changes?')
) {
  discardChanges() // the blocker now returns false
  await appUpdates.refresh.run()
}
```

To send the reload through a router, replace `reload`:

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

Importing `@ericchernuka/usher-plugin/client` also declares the global, typed and possibly `undefined`, so app code can check for it before calling it. The example apps under `examples/react/` put the same four modes on buttons, next to the update state, an update notice, and a draft that blocks a refresh. Run `pnpm build` once so the packages they import exist, then run one with `pnpm --filter usher-example-react-cloudflare-pages dev`.

The dev server then serves simulated build facts from the version URL while your app continues running the real build:

- `advance` serves a new version built now from the same commit. Your running app becomes outdated, and attention follows your thresholds counted from now.
- `force` does the same with a forced-update cutoff that covers the real build. Attention becomes `urgent` with reason `forced`.
- `rollback` serves a new version whose commit time is earlier than the real one. Attention becomes `urgent` with reason `rollback`.
- `reset` serves the real build facts again.

The promise resolves with the served build facts once the server updates. Your running app notices on its next check or when the page regains focus. Forced-update and rollback urgency stay active until reload, matching production. A freshly reloaded page still runs the real build, so it stays outdated until you call `reset` or restart Vite. Devtools only change `version.json` and do not exercise asset fallback. Production builds contain neither the global nor the endpoint.

## Testing update UI

`createTestTab()` stands in for a browser tab with virtual time. Pass it as the second argument to `createAppUpdates`:

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

`deploy` sets the build facts every version check gets, and `advance` moves time forward, running the checks and timers that fall due. Before the first `deploy` the test tab is offline. Its clock starts at the real time and then moves only when advanced. It needs nothing from the test runner but real timers to wait on, so leave `setTimeout` unfaked while it advances.

The app is outdated from the build time of the newer build, so give a deployed build the time `tab.now()` to start the count there, and keep the running build's commit time so the deploy is not taken for a rollback.

This recipe uses core, so it runs in any test runner. To test through the plugin's `/client` entry, the runner has to be built on Vite with `usher()` among its plugins, because the plugin supplies the build facts that entry imports. Vitest's browser mode needs nothing more. In Vitest's Node environments the plugin package also has to go through Vite, not Node's own loader:

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

The generated worker serves the current deploy's file first, falls back to R2 on a `404` or an SPA-fallback HTML response, and returns a real `404` with `Cache-Control: no-store` when neither has the chunk, so a browser that asks before the chunk reaches the archive does not keep the miss. A Cloudflare Cache Rule that overrides the browser TTL can replace that header, so leave the assets prefix (`/assets/*` by default) out of any such rule. Requests outside the assets prefix go straight to static assets. R2 keys are paths relative to `base`, matching `aws s3 sync dist/assets s3://<bucket>/assets` in CI. The R2 binding defaults to `CHUNK_ARCHIVE`. An adapter needs an absolute `base` or a CDN URL: with a relative `base`, chunks have no fixed path to route, so the build fails.

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

The `aws` CLI talks to S3 unless told otherwise, so give it R2's endpoint as shown here or in its profile. `$ACCOUNT_ID` is the Cloudflare account ID, and the credentials are an R2 API token's.

Uploading first ensures a client that loads the new `index.html` right as the deploy switches over can already fall back to R2. Omitting `--delete` is what keeps older running builds working; expire old chunks with an R2 lifecycle rule (for example, 30 days) instead.

Deploy one Workers version at a time. Alternating `version.json` responses during a gradual deployment can look like a rollback. R2 continues serving chunks for clients on a bad build until their users refresh.

## Rollbacks and forced updates

These behaviors work on every hosting provider, with or without an Usher adapter.

Dashboard rollbacks and old-commit redeploys are detected automatically through `commitTime`. Your build needs `.git` or `APP_COMMIT_TIME`; the plugin logs a warning when neither is present.

For a forward revert deployed as a new commit, set `APP_FORCE_UPDATE_BUILT_BEFORE` to the build time of the fix (`date -u +%Y-%m-%dT%H:%M:%SZ` in the deploy job). Every client running a build created before that timestamp becomes urgent immediately. This value is a build time, not a deadline: a timestamp later than the build itself fails the build because no refresh could ever satisfy it. Clearing `APP_FORCE_UPDATE_BUILT_BEFORE` in a later deploy does not lower urgency in clients that already observed it.

## Version file problems

A version check can get an answer that is not build facts: a `404`, a host's HTML fallback, or JSON of the wrong shape. The browser can also refuse the request outright, as it does when the page's Content Security Policy `connect-src` does not allow the version URL. Until that is fixed, running apps on that deployment cannot detect updates, and nothing in the update state says so. The version check logs one console warning per outage. Pass `onCheckProblem` to report it as well:

```ts
export const appUpdates = createAppUpdates({
  onCheckProblem: problem =>
    reportError(new Error(`version.json: ${problem.kind}`), problem),
})
```

| Kind              | Meaning                                                                                                  | Also carries                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `request-failed`  | The browser was online, but the request failed before any response, as when CSP `connect-src` blocks it. | Nothing more                    |
| `http-error`      | The response was not OK.                                                                                 | `status`                        |
| `not-json`        | The body was not JSON, as when a host answers with its HTML fallback.                                    | `contentType`, `null` if absent |
| `not-build-facts` | The JSON was the wrong shape.                                                                            | `issues`, in words for a person |

Every problem also carries `versionUrl`. The handler runs once per outage, and again if the file recovers and breaks later. It may be async; a throw or a rejection is logged and does not stop later checks. A request that fails while the browser is offline or the page is hidden, a timeout, and a connection that drops while the file is arriving do not call it, because those are normal for a running app. A flaky connection that the browser still counts as online can report `request-failed`, so an app that only wants configuration mistakes can filter on `kind`.

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

| Import                                  | What it gives you                                                                                    | Needs      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| `@ericchernuka/usher-plugin/vite`       | `usher()`: writes `version.json`, embeds build facts, runs a skew-protection adapter                 | Vite       |
| `@ericchernuka/usher-plugin/adapter`    | `SkewProtectionAdapter` and its types, for writing an adapter for another host                       | Nothing    |
| `@ericchernuka/usher-plugin/client`     | `createAppUpdates()` with build facts filled in, and `runningBuild`                                  | The plugin |
| `@ericchernuka/react-usher`             | `useUpdateState`, `useRefreshing`, `useRefreshBlocker`, `useUpdateNotice`, `UpdateNotice`            | React 19.2 |
| `@ericchernuka/usher-cloudflare`        | `cloudflarePages()`, `cloudflareWorkers()`: adapters that serve old chunks from R2                   | Cloudflare |
| `@ericchernuka/usher-cloudflare/worker` | `createAssetFallback()`: the same handler, for apps that own their Worker                            | Cloudflare |
| `@ericchernuka/usher-core`              | `createAppUpdates(options)`, `connectUpdateSurface()` and `createUpdateNotice()`, with no build tool | Nothing    |
| `@ericchernuka/usher-core/testing`      | `createTestTab()`: a stand-in browser tab with virtual time, for testing update UI                   | Nothing    |

### Plugin options

| Plugin option            | Default                                           | Meaning                                                                                                                                   |
| ------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `fileName`               | `version.json`                                    | Output file, relative to `outDir` and `base`.                                                                                             |
| `version`                | `APP_VERSION`, `GITHUB_SHA`, then `git rev-parse` | Source version of the build.                                                                                                              |
| `commitTime`             | `APP_COMMIT_TIME`, then `git log`                 | ISO 8601 commit time, used to detect rollbacks.                                                                                           |
| `forceUpdateBuiltBefore` | `APP_FORCE_UPDATE_BUILT_BEFORE`                   | ISO 8601 build time. Clients running a build made before it become urgent. Not a deadline: a value later than this build fails the build. |
| `adapter`                | None                                              | Skew-protection adapter. See [Skew protection](#skew-protection).                                                                         |
| `devtools`               | `false`                                           | Development only. Adds `__USHER_DEVTOOLS__.deploy()` to the page for simulating deploys.                                                  |

### The app's updates

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

Create one per `storageKey` in a document. Two that share a key in the same document do not hear each other's dismissals because the browser fires `storage` events only in other documents.

`state.get()` returns the same object reference until attention, reason, or any of the latest build facts change. `state.dismiss()` returns `true` only when it lowered a prompt; otherwise it returns `false` and writes nothing. Each behaviour has its own subscription: a listener on `state` hears about update state, and a listener on `refresh` hears when a refresh starts and ends.

Durations are in milliseconds so they can be computed directly:

```ts
import { createAppUpdates } from '@ericchernuka/usher-plugin/client'

const HOUR = 60 * 60 * 1000

export const appUpdates = createAppUpdates({
  promptAfter: 4 * HOUR,
  urgentAfter: 12 * HOUR,
})
```

| Option           | Default                            | Meaning                                                                                                                                      |
| ---------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`        | Required by core; set by `/client` | Build facts of the running build.                                                                                                            |
| `versionUrl`     | Required by core; set by `/client` | The serving deployment's `version.json` URL.                                                                                                 |
| `promptAfter`    | 12 hours                           | Time outdated at which a running app reaches prompt attention. `false` turns the level off.                                                  |
| `urgentAfter`    | 24 hours                           | Time outdated at which it reaches urgent attention. `false` turns the level off. Must be later than `promptAfter`.                           |
| `promptSnooze`   | Until urgent attention starts      | How long a prompt dismissal quiets prompt attention.                                                                                         |
| `pollInterval`   | 5 minutes                          | How often a visible page checks, at least 10 seconds. Focus and visibility changes also trigger a check, at most once a minute.              |
| `reload`         | `location.reload()`                | Document load performed by a refresh. Return or resolve `false` when you know it did not happen.                                             |
| `onCheckProblem` | None                               | Called when a version check cannot get build facts for a reason the deployment can fix. See [Version file problems](#version-file-problems). |
| `storageKey`     | `usher`                            | Prefix for keys Usher writes to `localStorage`, such as `usher:prompt-dismissal`. Set one per app when apps share an origin.                 |

Invalid options throw at creation, with a message naming the option.

Time outdated and dismissals are measured against the server's clock, read from the `Date` header of each `version.json` response. If `version.json` is served from another origin, include `Access-Control-Expose-Headers: Date`; without it, the client falls back to the user's local clock.

## Contributing

Usher is a pnpm workspace managed by Turbo. `packages/*` contains the libraries built with tsdown. `examples/react/*` contains sample Vite and React apps for Cloudflare Pages and Workers.

| Script              | Runs                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Coverage first, then all checks in parallel                                                                                                                                                                                                       |
| `pnpm build`        | tsdown for each package, then the examples                                                                                                                                                                                                        |
| `pnpm check:types`  | `tsc` per package and example (plus Workers types for the edge tests)                                                                                                                                                                             |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules                                                                                                                                     |
| `pnpm format`       | oxfmt (`pnpm check:format` checks)                                                                                                                                                                                                                |
| `pnpm test`         | Vitest: Node for everything that does not need a browser, Chromium (browser mode) for what does, and WebKit as well for what a screen reader hears; MSW for the network. Install the browsers with `pnpm exec playwright install chromium webkit` |
| `pnpm test:edge`    | The generated and composed workers in workerd, with R2 and asset serving                                                                                                                                                                          |
| `pnpm coverage`     | V8 coverage, merged for Fallow; each package must reach 95% on lines, branches, functions, and statements                                                                                                                                         |
| `pnpm check:fallow` | Fallow with merged coverage (run `pnpm coverage` first): dead code, duplication, complexity, dependencies                                                                                                                                         |
| `pnpm check:pack`   | Packs the four packages, installs the tarballs into a throwaway app outside the workspace, and runs its type check, production build, and dev server                                                                                              |

### Releases

Versions are managed with [Changesets](.changeset/README.md). Run `pnpm changeset` in any pull request that changes a published package. All four packages share one version.

The [release workflow](.github/workflows/release.yml) does the rest. When changesets land on `main`, it opens a "Version Packages" pull request that bumps versions and writes changelogs. Merging that pull request publishes to npm through trusted publishing and creates one GitHub release, `v<version>`, with notes generated from the merged pull requests. Locally, `pnpm version-packages` and `pnpm release` run the same two steps.

Each release job gets only the permissions it needs. Only the publish job can get npm credentials. It runs in the `npm` environment and never builds anything or runs dependency install scripts. The [CI workflow](.github/workflows/ci.yml) runs `pnpm check` and audits the workflows with zizmor on every pull request. Dependabot keeps the SHA-pinned actions current.

## License

[MIT](LICENSE)
