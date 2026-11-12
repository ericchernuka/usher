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

The update library is separate from the edge handler. See the [library README](../README.md) for its current interface, examples, and validation commands.

The Vite plugin writes `version.json` and embeds the same build facts in the client. `@app-version/core` polls that file and exposes an external store. `@app-version/react` reads the store and registers explicit refresh blockers. Each app chooses its update surface; `connectPrompt` supports imperative UI adapters.

Attention is passive for a newer build, prompt at 12 hours of running-build age, and urgent at 24 hours. Rollback and forced updates are urgent immediately and stay urgent until reload. The forced cutoff applies even to a rebuild of the same version.

Only prompts can be dismissed. A shared server-clock timestamp quiets tabs whose prompt threshold had already started, until each tab reaches urgent. An optional prompt snooze can set an expiry. Urgent states have no snooze, evidence record, or dismissal path.

The library never reloads on navigation or on a chunk-load error. R2 fallback protects old chunks. Explicit refresh remains available and can use app reload blockers or a router's own confirmation flow. Attention changes are facts; subscribers observe them but cannot veto them. Typing and clicking do not delay urgency.

### Internal modules

The pure policy returns one state and its next deadline. The machine keeps the published snapshot, sticky rollback or forced knowledge, and the server-clock estimate. The browser engine owns requests, visibility, storage events, and one wake timer. Scheduling reads the cached policy deadline and does not change the model.

Age deadlines are evaluated even if network checks fail. Hidden tabs stop their wake timer and catch up when visible. A pending fetch retains a 30-second timeout. Polling and the server-clock anchor use monotonic time, so wall-clock changes do not stall polling or shorten prompt dismissal.

Behaviour and model tests cover lifecycle, network failure and cancellation, prompt dismissal across tabs, storage failures, clock correction, rollback persistence, and explicit refresh. Chromium tests cover the real browser host and React integration; workerd tests cover the emitted Pages and Workers handlers.

### Rollbacks

A dashboard rollback or old-commit redeploy has an older `commitTime`, so no extra version signal is needed. A forward revert needs `APP_FORCE_UPDATE_BEFORE` for that deploy. R2 continues serving chunks to tabs on bad builds; the urgent surface asks users to refresh without forcing a reload.

Deploy one Workers version at a time. Gradual deployment can alternate `version.json` between commits and appear to be a rollback.

### Scope decisions

The core retains build-age escalation, cross-tab prompt dismissal, sticky urgency, explicit refresh, reload blockers, and prompt adapters. Cancelable attention changes, urgent dismissal, automatic navigation and chunk-error reloads, and typing/idle gates were removed to keep the interface small.

Server-driven compatibility signals are deferred. They are not part of the current library.

## Sources

- [Migrate from Pages to Workers (Cloudflare docs)](https://developers.cloudflare.com/workers/static-assets/migrate-from-pages/)
- [Workers vs. Pages compatibility matrix (Cloudflare docs)](https://developers.cloudflare.com/workers/static-assets/compatibility-matrix)
- [Cloudflare Pages vs Workers (Flavio Copes)](https://flaviocopes.com/cloudflare-pages-vs-workers/)
- Original pattern: Pontus Abrahamsson (@pontusab), "skew protection in 20 lines using Hono and R2"

* [Skew Protection (Vercel docs)](https://vercel.com/docs/skew-protection)
* [Deployment Retention (Vercel docs)](https://vercel.com/docs/deployment-retention)
