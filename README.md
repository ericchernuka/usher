# Usher

Usher keeps open tabs on a current build with as little disruption as possible. It pairs update prompts with skew protection: old tabs keep working after a deploy because their chunks stay reachable, so users are asked to refresh and are never reloaded by force.

The [glossary](GLOSSARY.md) defines the domain terms. The [architecture document](docs/Skew%20protection%20architecture.md) covers package ownership, internal modules, request handling and deployment.

| Import                            | What it gives you                                                                                    | Needs      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| `@rndsqr/usher-plugin/vite`       | `usher()`: writes `version.json`, embeds the build facts, runs a skew-protection adapter             | Vite       |
| `@rndsqr/usher-plugin/adapter`    | `SkewProtectionAdapter` and its types, for writing an adapter for another host                       | Nothing    |
| `@rndsqr/usher-plugin/client`     | `createAppUpdates()` with the build facts filled in, and `runningBuild`                              | The plugin |
| `@rndsqr/react-usher`             | `useUpdateState`, `useRefreshing`, `useRefreshBlocker`, `useUpdateNotice`, `UpdateNotice`            | React 19.2 |
| `@rndsqr/usher-cloudflare`        | `cloudflarePages()`, `cloudflareWorkers()`: adapters that serve old chunks from R2                   | Cloudflare |
| `@rndsqr/usher-cloudflare/worker` | `createAssetFallback()`: the same handler, for apps that own their Worker                            | Cloudflare |
| `@rndsqr/usher-core`              | `createAppUpdates(options)`, `connectUpdateSurface()` and `createUpdateNotice()`, with no build tool | Nothing    |
| `@rndsqr/usher-core/testing`      | `createTestTab()`: a tab with virtual time, for testing update UI                                    | Nothing    |

## Setup

Install the plugin and core, plus the packages for React and Cloudflare if the app uses them:

```sh
pnpm add @rndsqr/usher-core
pnpm add -D @rndsqr/usher-plugin
pnpm add @rndsqr/react-usher        # React hooks
pnpm add -D @rndsqr/usher-cloudflare # skew protection on Pages or Workers
```

`@rndsqr/usher-core` is a peer dependency of the plugin and the React package, so the app installs it once and every package shares that copy. The app also imports `connectUpdateSurface` and the types from it.

```ts
// vite.config.ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { usher } from '@rndsqr/usher-plugin/vite'

export default defineConfig({ plugins: [react(), usher()] })
```

Serve `version.json` uncached. The client also adds a `t` query parameter to each check. On Cloudflare Pages and Workers static assets, put this in `public/_headers`:

```
/version.json
  Cache-Control: no-store
```

Do not cache the HTML document at the edge either. A refresh has to load the new build's `index.html`, so serve it with `Cache-Control: no-cache` or the host's default.

Time outdated and dismissals are measured against the server's clock, read from the `Date` header of each check. If `version.json` is on another origin, that response needs `Access-Control-Expose-Headers: Date`; without it the tab falls back to the user's clock.

| Plugin option            | Default                                           | Meaning                                                                                                                                |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `fileName`               | `version.json`                                    | Output file, relative to `outDir` and `base`.                                                                                          |
| `version`                | `APP_VERSION`, `GITHUB_SHA`, then `git rev-parse` | The source version of the build.                                                                                                       |
| `commitTime`             | `APP_COMMIT_TIME`, then `git log`                 | ISO 8601 commit time, used to detect rollbacks.                                                                                        |
| `forceUpdateBuiltBefore` | `APP_FORCE_UPDATE_BUILT_BEFORE`                   | ISO 8601 build time. Tabs running a build made before it become urgent. Not a deadline: a value later than this build fails the build. |
| `adapter`                | None                                              | A skew-protection adapter. See below.                                                                                                  |
| `devtools`               | `false`                                           | Development only. Adds `__USHER_DEVTOOLS__.deploy()` to the page for simulating deploys. See below.                                    |

## Use it in an app

Create the app's updates once at module scope. Creating them has no side effects. `appUpdates.state` checks for a new build while it has at least one subscriber and stops after the last one leaves.

```ts
// updates.ts
import { createAppUpdates } from '@rndsqr/usher-plugin/client'

export const appUpdates = createAppUpdates()
```

```tsx
import {
  useRefreshBlocker,
  useRefreshing,
  useUpdateState,
} from '@rndsqr/react-usher'
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

  return null
}
```

Each hook takes the behaviour it reads. `useUpdateState` returns the whole state and defers it, so a change never blocks input. Read the field you need from it. `useRefreshing` is `true` while a refresh is in flight, which matters when the reload goes through a router and takes time. Reading it does not start version checks. `useRefreshBlocker` takes a boolean or a function; an inline function is fine, because the hook registers once and calls the latest one.

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

## The app's updates

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

Create one per `storageKey` in a document. Two that share a key in the same document do not hear each other's dismissals, because the browser reports a storage change only to other documents.

`state.get()` returns the same object until attention, reason, or any of the latest build facts change. `state.dismiss()` returns `true` only when it lowered a prompt; otherwise it returns `false` and writes nothing. Each behaviour has its own subscription: a listener on `state` hears about update state, and a listener on `refresh` hears when a refresh starts and ends.

Durations are milliseconds, so they can be computed:

```ts
import { createAppUpdates } from '@rndsqr/usher-plugin/client'

const HOUR = 60 * 60 * 1000

export const appUpdates = createAppUpdates({
  promptAfter: 4 * HOUR,
  urgentAfter: 12 * HOUR,
})
```

| Option           | Default                            | Meaning                                                                                                                           |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `running`        | Required by core; set by `/client` | Build facts of the running build.                                                                                                 |
| `versionUrl`     | Required by core; set by `/client` | The serving deployment's `version.json` URL.                                                                                      |
| `promptAfter`    | 12 hours                           | Time outdated at which a tab reaches prompt attention. `false` turns the level off.                                               |
| `urgentAfter`    | 24 hours                           | Time outdated at which it reaches urgent attention. `false` turns the level off. Must be later than `promptAfter`.                |
| `promptSnooze`   | Until urgent attention starts      | How long a prompt dismissal quiets prompt attention.                                                                              |
| `pollInterval`   | 5 minutes                          | How often a visible tab checks, at least 10 seconds. Focus and visibility also trigger a check, at most once a minute.            |
| `reload`         | `location.reload()`                | The document load a refresh performs. Return or resolve `false` when you know it did not happen.                                  |
| `onCheckProblem` | None                               | Called when the version file answers with something that is not build facts. See [Version file problems](#version-file-problems). |
| `storageKey`     | `usher`                            | Prefix for the keys Usher writes to localStorage, such as `usher:prompt-dismissal`. Set one per app when apps share an origin.    |

Invalid options throw at creation, with a message that names the option.

Usher never reloads on navigation, on a chunk error, or on its own timer. The asset fallback keeps old chunks available, and the tab refreshes only when the app calls `refresh.run()`.

### Version file problems

A version check can get an answer that is not build facts: a 404, a host's HTML fallback, or JSON of the wrong shape. Until that is fixed, tabs on that deployment cannot detect updates, and nothing in the update state says so. The version check logs one console warning per outage. Pass `onCheckProblem` to report it as well:

```ts
export const appUpdates = createAppUpdates({
  onCheckProblem: problem =>
    reportError(new Error(`version.json: ${problem.kind}`), problem),
})
```

| Kind              | Meaning                                                               | Also carries                    |
| ----------------- | --------------------------------------------------------------------- | ------------------------------- |
| `http-error`      | The response was not OK.                                              | `status`                        |
| `not-json`        | The body was not JSON, as when a host answers with its HTML fallback. | `contentType`, `null` if absent |
| `not-build-facts` | The JSON was the wrong shape.                                         | `issues`, in words for a person |

Every problem also carries `versionUrl`. The handler runs once per outage, and again if the file recovers and breaks later. It may be async; a throw or a rejection is logged and does not stop later checks. Network errors and timeouts do not call it, because a tab being offline is normal.

### Refresh and unsaved work

Refresh blockers decide whether a refresh can proceed. They run synchronously, in the order they were added, and a blocker that returns `true` or throws blocks the refresh. In React, `useRefreshBlocker(appUpdates.refresh, isDirty)` registers one while the component's effects are active. React removes the effects of a component inside a hidden `<Activity>`, so a draft that should block while hidden needs its blocker registered outside that boundary, or with `appUpdates.refresh.addBlocker`.

`refresh.run()` resolves with what happened:

| Outcome     | Meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `reloading` | `reload` ran and the document is being replaced.         |
| `blocked`   | A refresh blocker stopped it. `reload` was never called. |
| `declined`  | `reload` returned `false` or threw. The error is logged. |

Nothing is remembered between calls, so any outcome can be retried, and concurrent calls share one attempt. `refresh.get()` is `true` from the moment `reload` is called until it settles, and `false` again after every outcome. A blocked refresh never makes it `true`. To let the user override a blocker, confirm on `blocked`, remove the blocker, and call `refresh.run()` again:

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

This recipe is tested against TanStack Router, whose own blockers then apply to the reload. The router does not report a blocked navigation, so `refresh.run()` resolves `reloading` either way; use a refresh blocker when the app needs to know. For a refresh the current and next paths match, so a router blocker must check dirty state, not a pathname change.

## Update surfaces

`connectUpdateSurface` drives an imperative toast or banner library:

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

`notice.close()` means the user closed the surface. For a prompt it dismisses the prompt for every tab and then calls `hide()`. For a passive notice it calls `hide()` and stays hidden until attention or reason changes. A notice read with `createUpdateNotice` or the React parts keeps that close while it has a reader. If its last reader leaves and returns, as inside a hidden `<Activity>`, the close is kept only if the update state did not change in between. For an urgent notice it calls `show()` again with a new notice, because urgent attention cannot be closed and some libraries remove a toast regardless. Outside `connectUpdateSurface`, closing an urgent notice does nothing. A notice that is no longer the one shown ignores `close()`, so a library that fires `onClose` during a programmatic hide is safe.

Give urgent notices no timeout. A toast library that closes one on its own timer makes the connection show it again, and after five such rounds in one pass it stops and logs an error.

`disconnect()` hides the surface and removes its subscription. A surface that throws is isolated and retried on the next state change.

A notice's `latest` is the build that was latest when the notice was made. A notice is replaced when attention or reason changes, and when an urgent one is shown again; read the update state for the current build. Every notice also carries `closable`, which is `false` at urgent, and `announce`, which says how a screen reader should hear it: `off` at passive, `polite` at prompt, `assertive` at urgent. Pass `announce` to a toast library that owns its live region.

### A notice in React

A component that renders its own markup reads the same notice, with the same close rules, from `useUpdateNotice(appUpdates, { minAttention })`. The headless parts cover the common case:

```tsx
import { UpdateNotice } from '@rndsqr/react-usher'

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

`Root` renders its element only while there is a notice, with `data-attention` and `data-reason` for styling. `Refresh` is disabled, with `data-refreshing`, while a refresh is in flight. `Close` renders nothing at urgent. A part's own `onClick` runs before the part acts. The parts ship no wording and no styles, never move focus, and never close on a timer.

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

`Root` announces the notice with the wording its `announcement` prop returns. The prop is required, and an empty string announces nothing.

Each `Root` keeps a `status` and an `alert` region of its own beside the notice, visually hidden and present before there is anything to say. It puts the wording into the one that matches `announce`, so a screen reader hears a prompt politely and an urgent notice assertively, when the notice appears and again when the wording changes. Because the regions sit where the `Root` is rendered, a notice inside a modal dialog, a portal or another document is announced there. A `Root` given `hidden`, `inert` or `aria-hidden` stays silent. If a `Root` is hidden some other way, such as by a class, give it an empty string while it is. A notice on the page behind an open modal dialog is not heard while the dialog is open, since the page is inert then, and is not said again when it closes. The regions are hidden with styles set from script, so they need no inline style attribute and work under a strict content security policy. In server-rendered markup they carry `hidden` until then, so they take no space before the page hydrates. Two `Root`s that give wording for the same notice both announce it, so give the wording to one and an empty string to the other. The wording is the app's to give because only the app knows which of its text is the message: reading it back out of the markup means guessing what is hidden, decorative or a control.

## Testing update UI

`createTestTab()` is a tab with virtual time. Pass it as the second argument to `createAppUpdates`. With the plugin's `/client` entry, which needs Vite and so a runner built on it, such as Vitest:

```tsx
import { createTestTab } from '@rndsqr/usher-core/testing'
import { createAppUpdates, runningBuild } from '@rndsqr/usher-plugin/client'

const tab = createTestTab()
const appUpdates = createAppUpdates({}, tab)
render(<App appUpdates={appUpdates} />)

tab.deploy({
  ...runningBuild,
  version: 'next',
  buildTime: new Date(tab.now()).toISOString(),
})
await tab.advance(5 * MINUTE) // the next check sees the deploy
await tab.advance(12 * HOUR)
// the app now shows its prompt
```

`deploy` sets the build facts every version check gets, and `advance` moves time forward, running the checks and timers that fall due. Before the first `deploy` the tab is offline. The tab needs nothing from the test runner but real timers to wait on, so leave `setTimeout` unfaked while it advances.

In a runner without Vite, such as Jest, `/client` cannot be imported, because the plugin supplies its build facts. Use core's `createAppUpdates` there and give it the running build yourself:

````ts
import { createAppUpdates } from '@rndsqr/usher-core'
import { createTestTab } from '@rndsqr/usher-core/testing'

const tab = createTestTab()
const built = new Date(tab.now()).toISOString()
const running = { version: 'one', commitTime: built, buildTime: built }

const appUpdates = createAppUpdates(
  { running, versionUrl: '/version.json' },
  tab,
)

tab.deploy({ ...running, version: 'two' })
``` The tab's clock starts at the real time and then moves only when advanced. A tab is outdated from the build time of the newer build, so give a deployed build the time `tab.now()` to start the count there, and keep the running build's commit time so the deploy is not taken for a rollback.

## Skew protection

Skew protection is optional. Pass an adapter from a provider package, and the plugin writes the files that host needs:

```ts
import { cloudflarePages, cloudflareWorkers } from '@rndsqr/usher-cloudflare'

usher({ adapter: cloudflarePages() }) // { r2Binding? }
usher({
  adapter: cloudflareWorkers({ workerFile: 'dist-worker/index.mjs' }),
}) // { r2Binding?, workerFile? }
````

| Adapter               | Writes                                                                                      | You configure                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cloudflarePages()`   | `dist/_worker.js` (Pages advanced mode) and `dist/_routes.json` limited to `<base>assets/*` | An R2 binding on the Pages project. Pages ignores `functions/` once `_worker.js` exists |
| `cloudflareWorkers()` | `dist-worker/index.js` (`.js` or `.mjs`), outside `dist` so it's never served publicly      | `wrangler.jsonc`: `main`, `assets.run_worker_first: ["/assets/*"]`, the R2 binding      |

The generated worker serves the current deploy's file, falls back to R2 on a 404 or an SPA-fallback HTML response, and returns a real 404 when neither has it. Requests outside the assets prefix go straight to static assets. R2 keys are paths relative to `base`, matching `aws s3 sync dist/assets s3://<bucket>/assets` in CI. The R2 binding defaults to `CHUNK_ARCHIVE`. An adapter needs an absolute `base` or a CDN URL: with a relative `base` chunks have no fixed path to route, so the build fails.

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

Upload chunks before the deployment that references them goes live, and never delete from the archive in the same step:

```sh
aws s3 sync dist/assets "s3://$BUCKET/assets"   # no --delete
wrangler pages deploy dist                       # or: wrangler deploy
```

Uploading first means a tab that loads the new `index.html` in the first seconds can already fall back to R2. Leaving out `--delete` is what keeps old tabs working; expire old chunks with an R2 lifecycle rule instead.

Deploy one Workers version at a time. Alternating version responses during a gradual deployment can look like a rollback. R2 keeps serving bad-build tabs until their users refresh.

## Trying the flows in development

Turn on `usher({ devtools: true })` to simulate a deploy from the browser console while `vite` runs:

```js
await __USHER_DEVTOOLS__.deploy() // same as { mode: 'advance' }
await __USHER_DEVTOOLS__.deploy({ mode: 'force' })
await __USHER_DEVTOOLS__.deploy({ mode: 'rollback' })
await __USHER_DEVTOOLS__.deploy({ mode: 'reset' })
```

The example apps under `examples/react/` put the same four modes on buttons, next to the update state, an update notice and a draft that blocks a refresh. Run one with `pnpm --filter usher-example-react-cloudflare-pages dev`.

The dev server then serves different build facts from the version URL. The tab still runs the real build, so:

- `advance` serves a new version built now from the same commit. The tab is outdated, and attention follows the app's thresholds counted from now.
- `force` does the same with a forced-update cutoff that covers the real build. The tab becomes urgent with reason `forced`.
- `rollback` serves a new version whose commit time is earlier than the real one. The tab becomes urgent with reason `rollback`.
- `reset` serves the real build facts again.

The promise resolves with the build facts now being served, once the server has changed. The tab notices on its next check, or when it regains focus. Forced-update and rollback urgency stay until the tab reloads, as they do in production. A newly loaded tab still runs the real build, so it stays outdated until you call `reset` or restart Vite. This only changes `version.json`; it does not exercise asset fallback. Production builds contain neither the global nor the endpoint.

## Development

A pnpm workspace run by Turbo. `packages/*` are the libraries, built with tsdown. `examples/react/*` are sample Vite and React apps for Pages and Workers.

| Script              | Runs                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`        | Coverage first, then all checks in parallel                                                                                                                                                                                                      |
| `pnpm build`        | tsdown for each package, then the examples                                                                                                                                                                                                       |
| `pnpm check:types`  | `tsc` per package and example (plus Workers types for the edge tests)                                                                                                                                                                            |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules                                                                                                                                    |
| `pnpm format`       | oxfmt (`pnpm check:format` checks)                                                                                                                                                                                                               |
| `pnpm test`         | Vitest: Node for everything that doesn't need a browser, Chromium (browser mode) for what does, and WebKit as well for what a screen reader hears; MSW for the network. Install the browsers with `pnpm exec playwright install chromium webkit` |
| `pnpm test:edge`    | The generated and composed workers in workerd, with R2 and asset serving                                                                                                                                                                         |
| `pnpm coverage`     | V8 coverage, merged for Fallow; each package must reach 95% on lines, branches, functions and statements                                                                                                                                         |
| `pnpm check:fallow` | Fallow with merged coverage (run `pnpm coverage` first): dead code, duplication, complexity, dependencies                                                                                                                                        |
| `pnpm check:pack`   | Packs the four packages, installs the tarballs into a throwaway app outside the workspace, and runs its type check, production build and dev server                                                                                              |

### Releases

Versions are managed with [Changesets](.changeset/README.md). Run `pnpm changeset` in any pull request that changes a published package. `pnpm version-packages` applies the pending changesets, and `pnpm release` builds and publishes. The four packages share one version.
