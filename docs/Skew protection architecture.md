# Skew protection: architecture

The library keeps old chunks available across deployments and asks users to refresh an outdated tab. The product goals are in the [SPA one-pager](Skew%20protection%20for%20the%20SPA%20one-pager.md), domain terms are in the [glossary](../GLOSSARY.md), and setup and interface examples are in the [README](../README.md).

The repository contains the libraries, two sample app builds, and local browser and workerd tests. It does not contain a production CI deployment job, a provisioned R2 bucket, or deployment credentials. The deployment sequence below describes the remaining integration work.

## Package ownership

| Package                   | Responsibility                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@app-version/core`       | Build-tool-independent update state, polling, prompt dismissal, explicit refresh, and update surfaces. Its constructor accepts running-build facts and a version URL.      |
| `@app-version/vite`       | The build plugin, virtual build facts, and the skew-protection adapter contract. Its `/client` entry creates the core store with embedded build facts and the version URL. |
| `@app-version/react`      | Hooks that read a core store and register explicit refresh blockers.                                                                                                       |
| `@app-version/cloudflare` | Build adapters for Pages and Workers, plus the shared asset fallback handler.                                                                                              |

Core does not import Vite or a virtual module. The Vite client helper imports core. React uses the core store interface. Cloudflare implements the adapter contract exported by the Vite package. The sample apps assemble these pieces.

## Build output

The `appVersion()` plugin writes `version.json` and exposes the same build facts through `virtual:app-version`. The facts include a source version, commit time, build time, and an optional forced-update cutoff. A source version can occur in more than one build.

The version defaults to environment values and then Git. Commit time defaults to an explicit option, `APP_COMMIT_TIME`, and then Git. If no commit time is available, the plugin warns and uses build time, which prevents reliable detection of an old-commit redeploy. Malformed configured timestamps fail the build.

The plugin serves the version file during development and emits it only for client builds. A hosting adapter can add output during bundle generation or after files have been written. An adapter can fail the build through its context.

## Generated hosting adapters

Apps configure an adapter rather than copy the handler:

```ts
import { appVersion } from '@app-version/vite'
import { cloudflarePages, cloudflareWorkers } from '@app-version/cloudflare'

appVersion({ skewProtection: cloudflarePages() })
appVersion({ skewProtection: cloudflareWorkers() })
```

These are alternatives for the two hosting targets.

| Target  | Generated output                                                                                          | Deployment configuration                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages   | `_worker.js` and `_routes.json` inside the client output directory. Routes include only the asset prefix. | Set the R2 binding on the Pages project. Advanced mode takes precedence over `functions/`; the adapter warns if that directory exists.                                |
| Workers | A Worker entry outside the client output directory, by default `dist-worker/index.js`.                    | Point Wrangler `main` to that entry. Configure the static asset binding as `ASSETS`, enable SPA fallback, and restrict `assets.run_worker_first` to the asset prefix. |

Both adapters default to the `BUILD_CACHE` R2 binding. The binding name can be configured. The asset prefix includes Vite's base path and asset directory. The Workers output must stay outside the public client output directory; the adapter rejects an output path inside it.

The sample apps demonstrate the Vite configuration and update UI. Deployment configuration and account resources must be supplied for the target environment.

## Asset requests

1. Ask the current deployment's `ASSETS` binding for the request.
2. Pass non-GET and non-HEAD requests through unchanged.
3. Return the current asset if the response is neither a 404 nor HTML. HTML is treated as a miss because SPA fallback can return an index page for a missing chunk.
4. Look up the old asset in R2, using the request path relative to the configured base.
5. Return the stored asset with its HTTP metadata, ETag, and immutable cache header. Return a real 404 when no copy exists.

HEAD requests use R2 metadata without opening an object body. The handler releases an unused current-deployment response before returning a fallback. If the R2 binding is missing, it warns and returns a 404 for a missing asset rather than an HTML success response.

Generated Workers entries also check the asset prefix before calling the handler. Other paths go to static assets and SPA routing.

## Update state

Inside core, the store composes five sources, and dependencies point one way. No source knows about another source or about the store.

| Module                | Owns                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-updates.ts`      | Subscribers, the published snapshot, sticky urgency, and the one deadline timer for the next change of attention.                           |
| `attention.ts`        | Nothing. A pure function from running facts, latest facts, server time, the dismissal and thresholds to a state and its next deadline.      |
| `latest-build.ts`     | The last valid build facts observed, the poll schedule, the in-flight request and its 30-second timeout, and focus and visibility rechecks. |
| `server-clock.ts`     | The offset between server time and monotonic time.                                                                                          |
| `prompt-dismissal.ts` | The shared dismissal timestamp, in memory and in localStorage, and the storage event subscription.                                          |
| `refresh.ts`          | Refresh blockers and the one refresh attempt that concurrent callers share.                                                                 |

Every source calls back into the store's single `evaluate()`. It reads the latest build, the server time and the dismissal, asks `attention.ts` for a decision, keeps sticky urgency, publishes, and sets the deadline timer. Snapshot identity stays stable while attention, reason, and the latest build facts remain unchanged.

`attention.ts` compares source versions for ordinary update detection, commit times for rollback detection, and running-build time against the forced-update cutoff. Rollback and forced-update knowledge remains urgent after later deployments, including a deployment that matches the running version.

`server-clock.ts` anchors the response's Date header to monotonic time, so changing the user's clock cannot move build age. Before a Date header is available, it uses the local clock. Missing Date headers keep the last estimate, and changes under two seconds are treated as header rounding. Cross-origin version responses need `Access-Control-Expose-Headers: Date` for clock correction.

Hidden tabs keep no poll or deadline timer and catch up when visible. A pending request keeps its 30-second timeout and is aborted when the final subscriber leaves. Age evaluation continues on the deadline timer when network checks fail. The clock estimate, the last observed build and sticky urgency survive periods without subscribers.

The first time a store receives a response that is not OK or not build facts as JSON, it logs one warning naming the version URL. Network errors and timeouts stay silent.

`prompt-dismissal.ts` stores `{ "dismissedAt": <server time in ms> }` under `<storageKey>:prompt-dismissal`. Every tab of the app reads it, across releases, so the format is a contract. The latest dismissal wins. Dismissal quiets tabs whose prompt threshold had already started. It never quiets urgent attention. Without an explicit prompt snooze, dismissal lasts until urgent starts; if urgent is disabled, it has no expiry. Blocked storage keeps a dismissal for the current tab.

`refresh.ts` runs blockers synchronously. A throwing blocker prevents the refresh, and a failed or declined attempt can be retried. The app can supply a reload function to use its router's confirmation flow.

`connectUpdateSurface` connects an imperative update surface to the store. It handles attention thresholds, notices that are no longer shown, and surface callbacks during programmatic closure. Closing an urgent notice shows it again. A passive surface can be closed locally until its attention or reason changes.

## Deployment integration

The proposed deployment order is:

1. Build the app with content-hashed assets. If sourcemaps are required for Datadog, configure and upload them before removing them from public output.
2. Remove `.map` files from the output that will be published.
3. Sync assets to R2 without deleting previously shipped objects. For the default paths, sync `dist/assets` to the bucket's `assets` prefix.
4. Deploy the app and generated hosting output only after the asset sync succeeds.
5. Serve `version.json` with `Cache-Control: no-store`. Cross-origin version responses must expose their Date header if clock correction is required.

The proposed R2 retention is about 30 days. Bucket lifecycle rules, credentials, preview isolation, and production deployment remain operator decisions. No live deployment or Datadog outcome is claimed by the local tests.

A Pages-to-Workers migration reuses the R2 asset pool. Change the adapter factory, supply Workers deployment configuration, verify routing and bindings, and then move the domain. Existing tabs must retain access to the same chunk URLs throughout the change.

## Rollbacks and scope

Dashboard rollbacks and old-commit redeploys have an older commit time. A revert deployed as a new commit needs `APP_FORCE_UPDATE_BEFORE` when existing tabs must become urgent. R2 continues serving their chunks until users refresh.

Deploy one Workers version at a time. Alternating version responses during a gradual deployment can appear to be a rollback.

The library retains age-based escalation, shared prompt dismissal, sticky urgency, explicit refresh, refresh blockers, and update surfaces. It does not cancel attention changes, delay urgency for typing, reload on navigation, or reload on chunk errors. Server-driven compatibility signals are deferred.

## Verification

Behaviour and model tests cover lifecycle, network failure, cancellation, clock changes, storage failures, shared dismissal, rollback persistence, and explicit refresh. Chromium tests cover the browser environment, the Vite client helper, React hooks, and both sample update surfaces.

Vite tests build real output and check version metadata, emitted adapter assets, warnings, and build failure from adapter hooks. Workerd tests run the generated Pages and Workers handlers with static asset bindings and an R2 bucket. Local proof covers current chunks, R2 fallback, HEAD responses, missing chunks, and SPA routes.

Package scripts and workspace configuration define the current verification commands. See the README for usage.
