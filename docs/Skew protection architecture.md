# Skew protection: architecture

The library keeps old chunks available across deployments and asks users to refresh an outdated tab. The product goals are in the [SPA one-pager](Skew%20protection%20for%20the%20SPA%20one-pager.md), domain terms are in the [glossary](../GLOSSARY.md), and setup and interface examples are in the [README](../README.md).

The repository contains the libraries, two example apps, and local browser and workerd tests. It does not contain a production CI deployment job, a provisioned R2 bucket, or deployment credentials. The deployment sequence below describes the remaining integration work.

## Package ownership

| Package                    | Responsibility                                                                                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rndsqr/usher-core`       | The build-tool-independent behaviours: version check, signals, prompt dismissal, update state, refresh and update notice. `createAppUpdates` is a preset built from them, and `/testing` exports a tab with virtual time.                                                                                       |
| `@rndsqr/usher-plugin`     | The build plugin at `/vite`, the skew-protection adapter contract at `/adapter`, which names no bundler, and the browser entry at `/client`, which creates the core preset with the embedded build facts and version URL. Only Vite is implemented; the bundler is a subpath so another can be added beside it. |
| `@rndsqr/react-usher`      | Hooks that each read one behaviour, and headless update notice parts.                                                                                                                                                                                                                                           |
| `@rndsqr/usher-cloudflare` | Build adapters for Pages and Workers, plus the asset fallback handler at `/worker`.                                                                                                                                                                                                                             |

Core does not import a build tool. The plugin's client entry imports core. React uses the behaviours' `Readable` interface. Cloudflare implements the adapter contract from the plugin package's `/adapter` entry and uses only its types, so an app that imports just the asset fallback handler does not need the plugin installed. The example apps assemble these pieces.

Decisions that someone may want to reopen are recorded in [docs/adr](adr/).

## Build output

The `usher()` plugin writes `version.json` and embeds the same build facts in the bundle, where `@rndsqr/usher-plugin/client` reads them. The facts include a source version, commit time, build time, and an optional forced-update cutoff. A source version can occur in more than one build.

The version defaults to environment values and then Git. Commit time defaults to an explicit option, `APP_COMMIT_TIME`, and then Git. If no commit time is available, the plugin warns and uses build time, which prevents reliable detection of an old-commit redeploy. Malformed configured timestamps fail the build.

The plugin serves the version file during development and emits it only for client builds. With the `devtools` option, the dev server also owns a simulated deploy: `POST <base>__usher/deploy` replaces the build facts it serves with ones derived from the real build, and an inline script adds `__USHER_DEVTOOLS__.deploy()` to the page to call it. The endpoint accepts only `application/json`, which a page on another origin cannot send without a preflight the dev server does not answer. Neither exists in a production build. A skew-protection adapter describes the files its host needs: client files, which the plugin emits into the client output, and private files, which it writes relative to the Vite root. The plugin fails the build when a private file would land inside the client output, and it logs the adapter's warnings. Adapters write nothing themselves, so each one can be tested as a function call.

## Skew-protection adapters

Apps configure an adapter rather than copy the handler:

```ts
import { usher } from '@rndsqr/usher-plugin/vite'
import { cloudflarePages, cloudflareWorkers } from '@rndsqr/usher-cloudflare'

usher({ adapter: cloudflarePages() })
usher({ adapter: cloudflareWorkers() })
```

These are alternatives for the two hosting targets.

| Target  | Generated output                                                                                          | Deployment configuration                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages   | `_worker.js` and `_routes.json` inside the client output directory. Routes include only the asset prefix. | Set the R2 binding on the Pages project. Advanced mode takes precedence over `functions/`; the build warns if that directory exists.                                  |
| Workers | A Worker entry outside the client output directory, by default `dist-worker/index.js`.                    | Point Wrangler `main` to that entry. Configure the static asset binding as `ASSETS`, enable SPA fallback, and restrict `assets.run_worker_first` to the asset prefix. |

Both adapters default to the `CHUNK_ARCHIVE` R2 binding. The binding name can be configured. The asset prefix includes Vite's base path and asset directory. The Workers output must stay outside the public client output directory; the plugin rejects an output path inside it.

The sample apps demonstrate the Vite configuration and update UI. Deployment configuration and account resources must be supplied for the target environment.

## Asset requests

1. Ask the current deployment's `ASSETS` binding for the request.
2. Pass requests outside the asset prefix, and non-GET and non-HEAD requests, through unchanged.
3. Return the current asset if the response is neither a 404 nor HTML. HTML is treated as a miss because SPA fallback can return an index page for a missing chunk.
4. Look up the old asset in R2, using the request path relative to the configured base.
5. Return the stored asset with its HTTP metadata, ETag, and immutable cache header. Return a real 404 when no copy exists.

HEAD requests use R2 metadata without opening an object body. The handler releases an unused current-deployment response before returning a fallback. The handler's `env` type requires the R2 binding under its configured name. If a deployed Worker still lacks it, the handler warns, naming the binding to add, and returns a 404 for a missing asset rather than an HTML success response.

The handler is `createAssetFallback()` in `@rndsqr/usher-cloudflare/worker`, one type-checked module with no imports. Generated workers inline its source text and add a default export, so there is one copy of the handler and the generated file deploys without bundling. An app that already has a Worker imports the same function and calls it for requests it does not answer itself; that app owns its routing configuration.

## Update state

Core's public interface is its behaviours, and `createAppUpdates` composes them. See [ADR 0012](adr/0012-behaviours-are-the-public-interface.md) and the [design document](Behaviour-first%20API%20architecture.md). Dependencies point one way: the update state reads the version check and the dismissal, the notice reads the update state and the refresh, and nothing reads upward.

| Module                | Owns                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readable.ts`         | The `Readable` contract, and a set of listeners that starts its owner on the first subscriber and stops it after the last.                               |
| `tab.ts`              | A tab: the environment and the server clock. Behaviours reach both through it, and apps see only `now()`.                                                |
| `version-check.ts`    | The last valid build facts observed, the poll schedule, the in-flight request and its 30-second timeout, focus and visibility rechecks, check problems.  |
| `signals.ts`          | `defineSignal` and the three shipped signals. Each signal's memory: outdated since for escalation, and sticky urgency for rollback and forced update.    |
| `prompt-dismissal.ts` | The shared dismissal timestamp, in memory and in localStorage, and the storage event subscription.                                                       |
| `update-state.ts`     | The signals' trackers, the published snapshot, and the one deadline timer for the next change of attention.                                              |
| `refresh.ts`          | Refresh blockers, the one refresh attempt that concurrent callers share, and whether it is in flight.                                                    |
| `update-notice.ts`    | The notice a surface should show, and a local close.                                                                                                     |
| `update-surface.ts`   | The connection to an imperative surface: what it last showed, and the guard against a surface that re-triggers itself.                                   |
| `visible-timer.ts`    | One pending timer for its owner: the browser timer, the visibility subscription while armed, and the wait for a delay longer than a browser timer holds. |
| `server-clock.ts`     | The offset between server time and monotonic time.                                                                                                       |
| `options.ts`          | Nothing. Validates each behaviour's options and applies their defaults.                                                                                  |
| `environment.ts`      | Nothing. Describes what core needs from a tab: clocks, timers, fetch, storage, visibility, focus and reload.                                             |
| `fake-environment.ts` | The fake tab with virtual time that core's tests and `/testing` share.                                                                                   |

`environment.ts` is the one internal seam. Its browser adapter is the only code that touches globals, and the tests replace it with the fake. It is not part of the public interface: an app that tests its own update UI uses `createTestTab()` from `/testing`, which exposes `deploy` and `advance` and not the seam.

Each behaviour holds timers, listeners and requests only while it has a subscriber, and it subscribes to what it reads only while it has one itself. Subscribing to the refresh starts nothing else.

The update state has a single `evaluate()`, which the version check, the dismissal and visibility changes call. It asks each signal to observe the builds and then for its claim, turns a dismissed prompt claim into `passive` / `dismissed`, publishes the loudest claim, and sets the deadline timer for the earliest time a claim says it may change. The earlier signal in the list wins a tie, and the preset lists forced update, rollback, then escalation. Snapshot identity stays stable while attention, reason, and the latest build facts remain unchanged.

A tab is outdated since the build time of the first build it saw supersede its own, clamped to its own build time. `escalation()` keeps that time and measures the prompt and urgent thresholds from it. Later deploys do not move it, and a response that matches the running version clears it. See [ADR 0005](adr/0005-escalate-from-outdated-since.md).

Escalation compares source versions, `rollback()` compares commit times, and `forcedUpdate()` compares running-build time against the forced-update cutoff. Rollback and forced-update knowledge remains urgent after later deployments, including a deployment that matches the running version.

`server-clock.ts` anchors the response's Date header to monotonic time, so changing the user's clock cannot move a tab's time outdated. Before a Date header is available, it uses the local clock. Missing Date headers keep the last estimate, and changes under two seconds are treated as header rounding. Cross-origin version responses need `Access-Control-Expose-Headers: Date` for clock correction.

Hidden tabs keep no poll or deadline timer and catch up when visible. A pending request keeps its 30-second timeout and is aborted when the final subscriber leaves. Age evaluation continues on the deadline timer when network checks fail. The clock estimate, the last observed build and sticky urgency survive periods without subscribers.

When a version check gets a response that is not OK or not build facts as JSON, it reports one check problem and stays quiet until a valid response arrives. It logs the warning naming the version URL and passes the problem to the app's `onCheckProblem` if there is one. Network errors and timeouts stay silent. Timestamps in the file must be ISO 8601 with a time zone, and fields the store does not know are dropped.

`prompt-dismissal.ts` stores `{ "dismissedAt": <server time in ms> }` under `<storageKey>:prompt-dismissal`. Every tab of the app reads it, across releases, so the format is a contract. The latest dismissal wins. Dismissal quiets tabs whose prompt threshold had already started. It never quiets urgent attention. Without an explicit prompt snooze, dismissal lasts until urgent starts; if urgent is disabled, it has no expiry. Blocked storage keeps a dismissal for the current tab.

`refresh.ts` runs blockers synchronously, and a throwing blocker prevents the refresh. A refresh resolves `reloading`, `blocked` or `declined`, keeps no memory of the outcome, and can always be retried. While `reload` is running the refresh reports itself in flight and tells its subscribers when that starts and ends. The app can supply a reload function to send the document load through its router.

`update-notice.ts` decides what a surface should show: the attention threshold, one notice per change of attention or reason, a prompt close that dismisses, and a passive close that holds until attention or reason changes. A notice that is no longer shown ignores `close()`. `connectUpdateSurface` drives an imperative surface from a notice and handles surface callbacks during programmatic closure. Closing an urgent notice shows it again. The React parts read the same notice.

## Deployment integration

The proposed deployment order is:

1. Build the app with content-hashed assets. If sourcemaps are required for Datadog, configure and upload them before removing them from public output.
2. Remove `.map` files from the output that will be published.
3. Sync assets to R2 without deleting previously shipped objects. For the default paths, sync `dist/assets` to the bucket's `assets` prefix.
4. Deploy the app and generated hosting output only after the asset sync succeeds.
5. Serve `version.json` with `Cache-Control: no-store`. Cross-origin version responses must expose their Date header if clock correction is required.

The proposed R2 retention is about 30 days. Bucket lifecycle rules, credentials, preview isolation, and production deployment remain operator decisions. No live deployment or Datadog outcome is claimed by the local tests.

A Pages-to-Workers migration reuses the chunk archive. Change the adapter factory, supply Workers deployment configuration, verify routing and bindings, and then move the domain. Existing tabs must retain access to the same chunk URLs throughout the change.

## Rollbacks and scope

Dashboard rollbacks and old-commit redeploys have an older commit time. A revert deployed as a new commit needs `APP_FORCE_UPDATE_BUILT_BEFORE` when existing tabs must become urgent. R2 continues serving their chunks until users refresh.

Deploy one Workers version at a time. Alternating version responses during a gradual deployment can appear to be a rollback.

The library retains escalation, shared prompt dismissal, sticky urgency, explicit refresh, refresh blockers, and update surfaces. It does not cancel attention changes, delay urgency for typing, reload on navigation, or reload on chunk errors. Server-driven compatibility signals are deferred.

## Verification

Behaviour and model tests run against a fake environment with virtual time. They cover lifecycle, network failure, cancellation, clock changes, storage failures, shared dismissal, rollback persistence, and explicit refresh. Chromium tests cover the browser environment, the Vite client helper, React hooks, and both sample update surfaces.

Vite tests build real output and check version metadata, emitted and private adapter files, warnings, and the build failure for a private file inside the client output. Workerd tests run the generated Pages and Workers handlers, and a hand-written worker that composes the handler, with static asset bindings and an R2 bucket. Local proof covers current chunks, R2 fallback, HEAD responses, missing chunks, and SPA routes.

A smoke test packs the four packages, installs the tarballs into an app outside the workspace, and runs its type check, production build and dev server.

Package scripts and workspace configuration define the current verification commands. See the README for usage.
