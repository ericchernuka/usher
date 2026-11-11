# Skew protection for the SPA: one-pager

Nov 11, 2026 · @Eric Chernuka

## Purpose

We propose keeping every built JS/CSS chunk in an R2 bucket and serving old chunks from it when the current deploy no longer has them. This stops chunk-load errors in tabs that stay open across a deploy. We ask for approval to build this on Cloudflare Pages now and to plan a move to Workers static assets.

## Background

The SPA is a Vite build hosted on Cloudflare Pages. GitHub Actions builds it, uploads sourcemaps to Datadog, then uploads the build with `wrangler`. Vite writes chunks to `/assets/` with a content hash in each filename, and the app lazy-loads most routes as separate chunks.

Each deploy replaces the full set of files on the production domain. Pages keeps old deploys, but only at their own preview URLs.

## Problem

A tab opened before a deploy still runs the old JS. When that user goes to a route they haven't loaded yet, the browser asks for an old chunk name. The new deploy doesn't have that file, so the request misses.

- On Pages, the miss returns `index.html` with a 200, so the user sees a broken route or a failed import rather than a clean 404.
- To serve old chunks we would need to know which builds came before. Today we keep no clean record of past build IDs.

## Proposal

Treat R2 as an append-only pool of every chunk we have shipped. Because filenames are content-hashed, we never need to know build IDs.

1. **CI:** after the Datadog sourcemap upload, delete `.map` files and `aws s3 sync dist/assets` to R2 (no `--delete`), then deploy. Unchanged chunks are skipped.
2. **Edge:** a small handler on `/assets/*` serves the current deploy's file. If that file is missing (a 404 or an HTML fallback), it streams the file from R2 with `immutable` cache headers.
3. **Cleanup:** an R2 lifecycle rule expires objects after about 30 days.

The handler is about 20 lines. Every other path is untouched. Full design: [Skew protection: architecture](https://claude.ai/artifact/35StQit7hxSaDa5bbGSGNv).

## Pages or Workers

Ship on Pages first, then move to Workers. The handler code is nearly the same on both, so the second step is low risk.

|              | Pages (now)                                      | Workers static assets (later)                                |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------ |
| Handler      | Pages Function at `functions/assets/[[path]].ts` | Worker with `run_worker_first: ["/assets/*"]`                |
| SPA fallback | Built in                                         | `not_found_handling: "single-page-application"`              |
| Deploy       | `wrangler pages deploy`                          | `wrangler deploy`                                            |
| Cost         | Static free; function calls billed as Workers    | Same                                                         |
| Direction    | Maintained, few new features                     | Where Cloudflare ships new features                          |
| Extras       | None                                             | Workers Logs, Logpush, one config file for assets + bindings |

We already build in GitHub Actions and push with `wrangler`, so we lose little by leaving Pages' Git integration.

## Keeping users current and rollbacks

Skew protection keeps old tabs alive, so a shared `@repo/app-version` package moves them forward gently. A Vite plugin writes `version.json`; the client polls it. We don't reload on navigation, to avoid full page loads every deploy; users catch up through prompts or their own refreshes. Each app picks its surface (a toast, a nav-bar button, or both). Escalation is by build age, with typed thresholds defaulting to Vercel's skew-protection numbers: a gentle prompt at 12 h, urgent at 24 h, and urgent at once for a rollback or forced fix, which stays urgent until the tab reloads. Dismissing a prompt quiets every tab until the urgent level starts.

Rollbacks need no new steps for dashboard rollbacks or old-commit redeploys: the older commit time marks them urgent. A forward revert needs `APP_FORCE_UPDATE_BEFORE` set for one deploy. The trade-off: tabs on a bad build keep running it until they refresh, since R2 still serves its chunks.

## Success measures

- Chunk-load errors in Datadog RUM drop to near zero in the hour after each deploy. Baseline: open question.
- No `.map` files reachable on the public domain.
- Deploy time grows by under a minute for the R2 sync.

## Risks and open questions

- **Miss detection on Pages.** A missing asset returns `index.html` with a 200. The handler must treat an HTML response as a miss, or we add `assets/404.html`.
- **Order in CI.** If deploy runs before the R2 sync, new tabs can briefly miss chunks. CI must sync first.
- **Retention.** 30 days is a guess. How long do our users keep tabs open?
- **Preview deploys.** Do previews share the prod bucket or get their own?
- **Hard reloads.** This keeps old tabs working; it does not force them onto the new build. A version-check prompt is out of scope.

* **API compatibility window.** Without reload-on-navigate, the backend must keep working for clients about a day old. A server-driven signal (`x-min-client-version` or a GraphQL error code that raises urgent) is a possible next step.

## Next steps

- [ ] Create the R2 bucket, its lifecycle rule and a scoped R2 API token
- [ ] Add the strip-maps and R2 sync steps to the GitHub Actions deploy job
- [ ] Add the `/assets/*` Pages Function and R2 binding
- [ ] Pull a baseline chunk-load error rate from Datadog
- [ ] Scope the Workers migration (domain, previews, `_headers`/`_redirects`)

**Ask:** approve the Pages rollout now and a Workers migration spike next.
