# Skew protection: architecture

Nov 11, 2026 · @Eric Chernuka

Every hashed chunk we ship goes into an R2 bucket. A small handler on `/assets/*` serves the current deploy's file first and falls back to R2, so tabs on an older build keep loading their own chunks. The design works on Cloudflare Pages today and moves to Workers with a few lines changed.

## Components

| Piece                    | Lives in                      | Job                                                                                         |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Vite build               | GitHub Actions                | Emits `dist/` with content-hashed chunks in `/assets/` and hidden sourcemaps                |
| Datadog sourcemap upload | GitHub Actions                | Sends `.map` files to Datadog, tagged with the commit SHA as `release-version`              |
| R2 sync                  | GitHub Actions                | `aws s3 sync dist/assets` to the bucket, append-only, before deploy                         |
| `BUILD_CACHE` bucket     | Cloudflare R2                 | Holds every chunk from recent builds; lifecycle rule expires objects after about 30 days    |
| Static assets            | Pages deploy or Worker assets | The current build only; serves `index.html` and chunks                                      |
| `/assets/*` handler      | Pages Function or Worker      | Tries the current build, falls back to R2, sets `immutable` caching                         |
| Browser cache            | Browser                       | `immutable` headers mean each tab fetches a chunk once, so the handler runs rarely per user |

## Deploy flow

&#91;embedded content: GitHub Actions deploy job · 5 steps, 3 destinations\]

Step 4 must finish before step 5, so R2 already holds the new chunks when the new build goes live. Only the R2 sync is new; the other steps exist today.

## Request flow

&#91;embedded content: /assets/\* request path · 3 checks, 4 outcomes\]

Only `/assets/*` reaches the handler; every other path is served as static files with the SPA fallback. Because chunks carry `immutable` headers, each tab fetches a given chunk at most once.

## On Pages today

A Pages Function at `functions/assets/[[path]].ts`. Pages builds `_routes.json` from the `functions/` folder, so only `/assets/*` invokes it. All other paths, including the SPA fallback, stay static and free.

```ts
interface Env {
  BUILD_CACHE: R2Bucket
}

export const onRequestGet: PagesFunction<Env> = async ({
  request,
  env,
  next,
}) => {
  const res = await next() // current deploy's static file
  const isHtml = res.headers.get('content-type')?.includes('text/html')
  if (res.status !== 404 && !isHtml) return res

  const key = new URL(request.url).pathname.slice(1)
  const old = await env.BUILD_CACHE.get(key)
  if (!old) return new Response('Not found', { status: 404 })

  const headers = new Headers()
  old.writeHttpMetadata(headers)
  headers.set('ETag', old.httpEtag)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  return new Response(old.body, { headers })
}
```

```toml
# wrangler.toml
name = "my-app"
pages_build_output_dir = "dist"

[[r2_buckets]]
binding = "BUILD_CACHE"
bucket_name = "spa-build-cache"
```

Gotchas:

- With no `404.html`, Pages answers a missing `/assets/x.js` with `index.html` and a 200. The `isHtml` check catches that. Adding `public/assets/404.html` also works, since Pages uses the closest `404.html`.
- A `304` has no content-type and passes straight through, which is what we want.

## On Workers

The same logic, in a Worker. `run_worker_first` limits the Worker to `/assets/*`. Assets handle every other path, and SPA mode serves `index.html` for deep links. No catch-all route is needed.

```ts
// src/index.ts
interface Env {
  ASSETS: Fetcher
  BUILD_CACHE: R2Bucket
}

export default {
  async fetch(request: Request, env: Env) {
    const res = await env.ASSETS.fetch(request)
    const isHtml = res.headers.get('content-type')?.includes('text/html')
    if (res.status !== 404 && !isHtml) return res

    const key = new URL(request.url).pathname.slice(1)
    const old = await env.BUILD_CACHE.get(key)
    if (!old) return new Response('Not found', { status: 404 })

    const headers = new Headers()
    old.writeHttpMetadata(headers)
    headers.set('ETag', old.httpEtag)
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    return new Response(old.body, { headers })
  },
} satisfies ExportedHandler<Env>
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "src/index.ts",
  "assets": {
    "directory": "dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/assets/*"],
  },
  "r2_buckets": [
    { "binding": "BUILD_CACHE", "bucket_name": "spa-build-cache" },
  ],
}
```

What changes from Pages: `next()` becomes `env.ASSETS.fetch(request)`, `wrangler pages deploy` becomes `wrangler deploy`, and the custom domain moves to the Worker. CI and the R2 bucket stay the same.

### Generated by the Vite plugin

Apps don't copy the handler by hand: `appVersion({ skewProtection: { target } })` emits it at build time from one shared source.

| Target    | Writes                                                                                      | App configures                                                                       |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pages`   | `dist/_worker.js` (Pages advanced mode) and `dist/_routes.json` limited to `<base>assets/*` | R2 binding on the Pages project. Pages ignores `functions/` once `_worker.js` exists |
| `workers` | `dist-worker/index.js`, outside `dist` so it's never served publicly                        | `wrangler.jsonc` `main`, `assets.run_worker_first`, R2 binding                       |

Switching from Pages to Workers is then a one-word config change plus the wrangler settings.

The emitted worker is tested inside workerd with `@cloudflare/vitest-plugin`: one suite runs against both targets, using Pages' own `ASSETS` binding and Workers static assets in SPA mode, with a simulated R2 bucket. Removing the SPA-fallback HTML check fails 4 of those tests, and workerd caught an unread R2 body on HEAD requests, now fixed with `bucket.head()`.

## Why move to Workers

- **Where new features land.** Cloudflare recommends Workers static assets for new projects and focuses new work there. Pages keeps working.
- **Same cost.** Static requests are free on both; Pages Functions are billed at Workers rates.
- **Better observability.** Workers Logs and Logpush are available; Pages has neither.
- **One config.** Assets, R2, routing and any future cron or KV live in one `wrangler.jsonc`.
- **Tighter routing control.** `run_worker_first` takes a list of path patterns, so we can add more Worker routes later without moving files around.
- **Little lost for us.** We already build in GitHub Actions and deploy with `wrangler`, so Pages' Git integration buys us nothing.

Costs to check: preview URLs work differently, `_headers`/`_redirects` support differs (see the compatibility matrix), and the custom domain must move.

## Migration steps

1. Ship skew protection on Pages; confirm chunk-load errors drop in Datadog.
2. Add `src/index.ts` and `wrangler.jsonc` beside the Pages config. Deploy to a `workers.dev` URL from a branch.
3. Check `_headers`/`_redirects`, preview flow and any Pages-only settings against the compatibility matrix.
4. Switch the GitHub Actions deploy step from `wrangler pages deploy` to `wrangler deploy`. Keep the R2 sync before it.
5. Move the custom domain from the Pages project to the Worker.
6. Delete `functions/assets/` and retire the Pages project after a week of clean traffic.

The R2 bucket carries over as is, so tabs open during the cutover keep working.

## Keeping tabs current

Skew protection keeps old tabs working, so routine deploys never need a forced reload. One package, `@repo/app-version`, moves users forward with as little disruption as possible. Its core is headless: it decides how loudly to signal an update, and each app decides how to show it.

| Entry point               | What                                                                                                                                                                                                                  | Needs   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `@repo/app-version/vite`  | `appVersion()` writes `version.json` and provides `virtual:app-version` with the same values; optionally emits the edge handler                                                                                       | Vite    |
| `@repo/app-version`       | `createAppUpdates()`: an external store (`getState`, `subscribe`, `addReloadBlocker`, `refresh`, `dismiss`), created once at module scope. `connectPrompt(store, { show, hide })`: drives any toast or banner library | Nothing |
| `@repo/app-version/react` | `useAppUpdates(store, selector?)`, `useReloadBlocker(store, shouldBlock)`                                                                                                                                             | React   |

The package has no UI-library dependency. `connectPrompt` owns the lifecycle details (threshold, one show per change with a stable id, stale handles that ignore a library's own close events, re-showing a refused dismiss), so a Base UI or Sonner adapter is a dozen lines of mapping. Both are README recipes; the Base UI one is tested against real Base UI.

The integration follows the Zustand and TanStack Store model: each app creates one store at module scope, passing app-wide options (`onAttentionChange`, `reload`, optional `subscribeToNavigation`). Components read it with `useAppUpdates(store, selector)`, which wraps `useSyncExternalStore` and re-renders only when the selected value changes. Forms with unsaved work register a veto with `useReloadBlocker`, modeled on React Router's `useBlocker`. There is no provider, and the React layer has no refs; it passes the `eslint-plugin-react-hooks` v7 Compiler rules.

&#91;embedded content: app-version seams · 2 ports in, any surface out\]

The core never imports a router or a UI library. Apps hand it two functions and read its state.

| Situation                                                                           | `attention` (`reason`)           |
| ----------------------------------------------------------------------------------- | -------------------------------- |
| Not checked yet                                                                     | `none` (`unknown`)               |
| Same build                                                                          | `none` (`caught-up`)             |
| Newer build                                                                         | `passive` (`new-build`)          |
| A raise waiting for an idle, visible tab                                            | `passive` (`waiting`)            |
| A snooze holding a higher level back                                                | `passive` (`dismiss`)            |
| The app canceled a higher level                                                     | `passive` (`declined`)           |
| Running build older than `escalation.prompt.after` (12 h)                           | `prompt` (`stale`)               |
| Running build older than `escalation.urgent.after` (24 h)                           | `urgent` (`expired`)             |
| Rollback, or forced cutoff (even on the same version); sticky until the tab reloads | `urgent` (`rollback` / `forced`) |

`dismiss()` works out the result with the snooze in place before doing anything. A dismissal records _when_ a level was dismissed, on the server clock. It covers every tab whose level had already started, until that tab's next level: one prompt per level, in every tab. An urgent dismissal lasts 30 minutes and also quiets prompts. Dismissing a rollback or forced update covers our build and the evidence seen, so new deploys don't re-raise it, but a new cutoff does.

### Change callbacks

Both callbacks copy Base UI's `onOpenChange(open, eventDetails)` shape: a `reason`, some context, and `cancel()` / `isCanceled`.

| Option                                  | `details.reason`                                                                                                           | What the app controls                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onAttentionChange(attention, details)` | Per level: `unknown`, `caught-up`, `new-build`, `dismiss`, `waiting`, `declined`, `stale`, `rollback`, `forced`, `expired` | `cancel()` vetoes raises and this tab's own dismiss (`details.cancelable`). Lowerings, catching up, reason changes within a level and other tabs' dismissals are reported as facts |
| `reload(details)`                       | `navigate`, `refresh`                                                                                                      | _How_ the reload happens, possibly async. Return or resolve `false` if it didn't. Synchronous reload blockers decide _whether_, and are the only veto for `chunk-error`            |

Cancelling a raise only defers it: the tab reads `passive` (`declined`), and the change is offered again after the next successful check, so an urgent rollback can wait out a checkout but can't stay hidden. Both callbacks are natural places to send Datadog RUM actions for prompts, dismissals and reloads; reason changes within a level (say `expired` to `rollback`) are reported too.

### Reloading through the router

The app's `reload` decides _how_ a reload happens. Routing it through TanStack Router reuses the navigation blockers the app already has: `router.navigate({ href, reloadDocument: true })` awaits every `useBlocker` blocker before touching `window.location`. This is confirmed in the router's source and tested against the real router.

```ts
reload: async ({ href }) => {
  await router.navigate({ href, reloadDocument: true, replace: true })
  return false // still here afterwards = a blocker stopped it
}
```

Caveat: for a reload, the current and next locations are the same, so blockers must block on dirty state, not on a pathname change.

### How the store is built

Three review rounds kept finding bugs where rules met: the idle/visible gate, vetoes, re-entrant calls and time. So the store became an explicit state machine with a pure policy at its center:

| Part          | What it holds or does                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model         | Published state, a sticky "known bad" record with its evidence, the last vetoed raise, the server clock (anchored to `performance.now()`), snoozes                                                                     |
| Inputs        | Check results, time (deadlines), visibility, focus, typing, other tabs, dismiss                                                                                                                                        |
| Policy (pure) | Returns the target, what may be published now (a truthful hold while the user is busy), the reason, and its own deadlines                                                                                              |
| Machine       | The only writer. Offers raises and this tab's dismiss to `onAttentionChange` atomically; reports everything else as facts                                                                                              |
| Engine        | One timer from the deadlines; every wake re-evaluates, so escalation happens even while checks fail; no wake timer while hidden; polling and idleness on the monotonic clock, so a jumping user clock can't stall them |

Model-based tests generate random worlds (six escalation configs, server clock skew up to ±3 h with 1 s `Date` headers) and event sequences, including flapping builds, other tabs, resubscribes and clock jumps. They check invariants after every step, such as one prompt per level and no urgent snooze cut short. Twelve deliberate breakages of the core each fail at least one test. A fourth review, of the model itself, found ten gaps (two medium); all are fixed and pinned by tests.

`UpdateState`, `Prompt` and the callback details are discriminated unions, so impossible states don't type-check. The package passes oxfmt, oxlint (complexity ≤ 10, files ≤ 300 lines) and fallow health on every change.

**No reload on navigation by default.** With deploys every 10 to 15 minutes, reloading on route changes would give active users a full page load about once per deploy: a white flash, a cold Apollo cache and a full app boot. Skew protection keeps stale tabs working, so we rely on prompts and the user's own refreshes instead. Vercel takes the same stance: a hard refresh or new tab gets the latest build, and nothing forces one. `subscribeToNavigation` stays available as an opt-in for apps with long sessions and no unsaved state.

- Raising attention to `prompt` or `urgent` waits for a visible tab and 5 s without typing or clicking. Lowering is immediate.
- One prompt per level, shared across tabs through `localStorage`.
- Polls every 5 min only while the tab is visible, plus on focus.
- Any reload is skipped while a `useReloadBlocker` is blocking, or when the app's `reload` declines it.
- `vite:preloadError` reloads once, with a loop guard, if a chunk still fails.

`version.json` must be served with `Cache-Control: no-store`; the client also adds a `?t=` query.

### Timings

Escalation is by build age only, on the server clock; there is no calendar-day rule. Thresholds are a typed option using `Duration` strings (`"30s"`, `"5m"`, `"12h"`, `"2d"`), validated when the store is created. The defaults are Vercel's skew-protection numbers:

| Setting                    | Default | Vercel equivalent                                                                                                              |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `escalation.prompt.after`  | `"12h"` | [Default maximum age on Pro: 12 hours from deployment creation](https://vercel.com/docs/skew-protection#configure-maximum-age) |
| `escalation.urgent.after`  | `"24h"` | [Default maximum age on Enterprise: 1 day](https://vercel.com/docs/skew-protection#configure-maximum-age)                      |
| `escalation.urgent.snooze` | `"30m"` | No equivalent                                                                                                                  |
| R2 lifecycle               | 30 days | [Default production deployment retention on Pro: 30 days](https://vercel.com/docs/deployment-retention)                        |
| `APP_FORCE_UPDATE_BEFORE`  | Unset   | [Custom Skew Protection Threshold](https://vercel.com/docs/skew-protection#custom-skew-protection-threshold)                   |

```ts
createAppUpdates({
  escalation: {
    prompt: { after: '12h' },
    urgent: { after: '24h', snooze: '30m' },
  },
})
```

The 24 h cap sets the backend's compatibility window: GraphQL changes must keep working for clients about a day old, plus the time users take to act on an urgent prompt.

`pollEvery` defaults to `"5m"` and must be at least `"10s"`. Build age and snoozes use the server's `Date` header; changes under 2 s (the header's rounding) are ignored.

### Possible angle: server-driven updates

Not built. When a backend change breaks old clients, the API could return a header such as `x-min-client-version`, or a known GraphQL error code, and the core would raise `urgent` (`forced`) on its own. This ties the prompt to real incompatibility rather than a timer, and removes the need to remember `APP_FORCE_UPDATE_BEFORE`. Open questions: which layer sets the header, and whether the Apollo link or the core reads it.

## Rollbacks

Rollbacks still work, but skew protection changes one thing: tabs already running a bad build keep running it, because R2 keeps serving its chunks. The urgent toast is what moves those tabs off it.

| How we roll back                                            | R2                                                             | Detected as                  | Action needed                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| Dashboard rollback (Pages) or `wrangler rollback` (Workers) | Skips CI; not needed, the restored deploy ships its own assets | Rollback: older `commitTime` | None                                                               |
| CI redeploy of an older commit                              | Synced as usual; files already there are skipped               | Rollback: older `commitTime` | None                                                               |
| Revert commit, deployed forward                             | Synced as usual                                                | Normal update (silent)       | Set `APP_FORCE_UPDATE_BEFORE` to now, deploy, clear it a day later |

Other effects:

- **Datadog:** sourcemaps for both builds stay uploaded, so errors from bad-build tabs and from the restored build both map correctly.
- **Faster eviction, optional:** delete the bad build's chunks from R2. Its tabs then hit `vite:preloadError` on the next lazy route and reload once onto the good build. Only delete hashes unique to the bad build; shared chunks are still in use.
- **Workers gradual deployments:** while two versions split traffic, `version.json` can alternate between them, and a tab on the newer version would see a false rollback. Ship 100% at once, or require two polls in a row to agree before an urgent toast. Open item.
- **Retention:** a rollback target older than the R2 lifecycle (about 30 days) still works, since its deploy carries its own assets. Only tabs from builds older than 30 days lose their fallback.

## Decisions

| Date       | Decision                                                                                                       | Why                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 2026-11-11 | Model the store as an explicit state machine, checked by model-based tests                                     | Reviews kept finding bugs where rules met; an explicit model makes those states visible and testable    |
| 2026-11-11 | Escalate by build age only, with typed thresholds                                                              | Removes client clock, time zones and DST; two tabs on one build always agree                            |
| 2026-11-11 | Delegate _how_ to reload to the app                                                                            | Reuses router blockers; async confirmation                                                              |
| 2026-11-11 | `useAppUpdates` returns a deferred value                                                                       | Concurrent-friendly reads from an external store; see below                                             |
| 2026-11-11 | One store per app at module scope; selector hook, no provider                                                  | Matches Zustand and TanStack Store                                                                      |
| 2026-11-11 | The Vite plugin emits the edge handler for Pages or Workers                                                    | One shared handler; no per-app copies                                                                   |
| 2026-11-11 | No reload on navigation by default                                                                             | Avoids a full page load per deploy at a 10–15 min cadence                                               |
| 2026-11-11 | Snoozes record when a level was dismissed (server clock); known-bad dismissals keyed by our build and evidence | Client end times broke under clock rounding and across tabs; keying by latest re-raised on every deploy |

### `useAppUpdates` returns a deferred value

**Decision.** The hook reads with `useSyncExternalStore` and returns `useDeferredValue(value)`.

**Context.** Updates through `useSyncExternalStore` always render at urgent priority and can't be marked as a transition; React has no concurrent-safe replacement yet. Asked about that gap, Ricky Hanlon of the React core team recommended this exact wrapping (reply to Mark Erikson on X, 2026-04-21).

**Effect.** On a store change, the subscribing component's urgent render gets the previous value and bails out cheaply. React then renders the new value at transition priority: interruptible, never blocking input, and keeping current UI rather than showing a Suspense fallback.

**Trade-offs.** One extra cheap render per change, negligible at a few changes a day. Surfaces lag the store by about a frame. Actions never use the deferred value: `refresh()`, `dismiss()`, reload blockers and `connectPrompt` read the store directly. There is no `isPending`; a consumer that needs one compares an urgent read with the deferred one.

**Rejected.** Leaving the hook urgent and documenting `useDeferredValue` for consumers: every consumer would need to know to add it, for no benefit at this update rate.

## Sources

- [Migrate from Pages to Workers (Cloudflare docs)](https://developers.cloudflare.com/workers/static-assets/migrate-from-pages/)
- [Workers vs. Pages compatibility matrix (Cloudflare docs)](https://developers.cloudflare.com/workers/static-assets/compatibility-matrix)
- [Cloudflare Pages vs Workers (Flavio Copes)](https://flaviocopes.com/cloudflare-pages-vs-workers/)
- Original pattern: Pontus Abrahamsson (@pontusab), "skew protection in 20 lines using Hono and R2"

* [Skew Protection (Vercel docs)](https://vercel.com/docs/skew-protection)
* [Deployment Retention (Vercel docs)](https://vercel.com/docs/deployment-retention)
