# app-version

Keeps open tabs on a current build with as little disruption as possible. Pairs with R2 skew protection: old tabs keep working, so users are moved forward with prompts, not forced reloads.

| Package                   | Import                    | What                                                                                                   | Needs      |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `@app-version/core`       | `@app-version/core/vite`  | `appVersion()` plugin: writes `version.json`, provides `virtual:app-version`, runs a skew adapter      | Vite       |
|                           | `@app-version/core`       | `createAppUpdates()`: the update store (a state machine); `connectPrompt()`: drive any toast/banner UI | —          |
| `@app-version/react`      | `@app-version/react`      | `useAppUpdates(store, selector?)`, `useReloadBlocker(store, shouldBlock)`                              | React      |
| `@app-version/cloudflare` | `@app-version/cloudflare` | `cloudflarePages()`, `cloudflareWorkers()`: skew-protection adapters that serve old chunks from R2     | Cloudflare |

## Setup

```ts
// vite.config.ts
import { appVersion } from '@app-version/core/vite'
export default defineConfig({ plugins: [react(), appVersion()] })
```

```jsonc
// tsconfig.json
{ "compilerOptions": { "types": ["vite/client", "@app-version/core/client"] } }
```

Serve `version.json` uncached (the client also adds `?t=`):

```
/version.json
  Cache-Control: no-store
```

### Skew protection (optional)

Pass an adapter from a provider package. Each factory returns a `SkewProtectionAdapter` (`kind: 'skew-protection'`, a `name`, and build hooks), in the style of TanStack AI's provider adapters:

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
// src/updates.ts: created once, at module scope
import { createAppUpdates, connectPrompt } from '@app-version/core'

export const appUpdates = createAppUpdates({
  escalation: { prompt: { after: "12h" }, urgent: { after: "24h", snooze: "30m" } }, // the defaults
  onAttentionChange: (attention, details) =>
    datadogRum.addAction("app-update", { attention, reason: details.reason, source: details.source }),
});

connectPrompt(appUpdates, { show: …, hide: … }); // optional; see "Prompts"
```

```tsx
import { useAppUpdates, useReloadBlocker } from '@app-version/react'

function NavUpdateButton() {
  const attention = useAppUpdates(appUpdates, s => s.attention) // select a field, not a new object
  if (attention === 'none') return null
  return (
    <IconButton data-attention={attention} onClick={() => appUpdates.refresh()}>
      Update
    </IconButton>
  )
}

function JobForm() {
  const form = useForm()
  useReloadBlocker(appUpdates, form.formState.isDirty) // like React Router's useBlocker
}
```

`useAppUpdates` returns a deferred value (see [Decisions](#decisions)); in development it logs an error if a selector returns a new value each time.

## How it works: an explicit state machine

```
Model    published UpdateState · knownBad (sticky, with evidence) · vetoed raise · server clock · snoozes
Inputs   check result · time (deadlines) · visibility · focus · input · other tab · dismiss
Policy   decide(facts) → { target, publish, reason, deadlines }   (pure, packages/core/src/policy.ts)
```

- **One writer.** Every input becomes `apply()` (facts changed) or `dismiss()` (user intent) in `src/machine.ts`, the only code that changes state. Each asks the pure policy, offers the change to `onAttentionChange` when it's the app's to veto, and publishes one consistent snapshot. Offers are atomic: `dismiss()` called from inside `onAttentionChange` is ignored with a warning (use `details.cancel()`).
- **The policy owns every reason and every hold.** While the user is busy or the tab is hidden, a raise publishes a truthful hold (`passive:waiting`, or stays at `prompt:stale`) instead of a made-up reason. A raise the app vetoed reads `passive:declined`, never a stuck `waiting`.
- **Time is an event.** The policy returns its own deadlines (when the build crosses each threshold, when a snooze expires). The engine keeps one timer at the earliest of those, the next poll, and idle release. Every wake re-evaluates first, so escalation happens even while checks fail. Hidden tabs have no wake timer (a fetch already in flight keeps its 30 s timeout until it settles). Polling and idleness run on `performance.now()`, so the user's clock jumping can't stall them.
- **Known-bad is sticky.** Once this tab learns its build was rolled back or force-updated, it stays `urgent` until it reloads, even after a fix ships or `latest` flaps. It keeps the evidence it has seen (`rollback`, each `forceUpdateBefore` cutoff); only new evidence breaks through a dismissal.
- **Vetoes are explicit.** A canceled raise is remembered and offered again after the next successful check (or sooner if the target itself changes), not on every input.
- **Server clock.** Build age and dismissals use the server's `Date` header, anchored to `performance.now()` at the last check. Changes under 2 s (the header's 1 s rounding) are ignored; a missing header keeps the last estimate. Two tabs on the same build agree to within that.
- **Snoozes record when a level was dismissed** (server clock), not a client end time. A dismissal covers every tab whose level had already started, until that tab's next level: one prompt per level, in every tab. A build that goes stale later prompts afresh. localStorage carries them between tabs; on resubscribe, readable storage wins (a clear while unsubscribed still un-snoozes), unless this tab's last write failed.

Checked by model-based tests (`test/model.test.ts`, world in `test/model/world.ts`). fast-check generates random worlds (six escalation configs, server clock skew up to ±3 h with 1 s `Date` headers) and event sequences: time, deploys, flapping builds, rollbacks, outages, visibility, typing, other tabs setting and clearing snoozes, dismissals, vetoes, reloads, resubscribes and clock jumps. Three generators: random, rollback-then-fix, and age escalation (wait, dismiss, wait, dismiss). Invariants after every step:

- every published change of attention or reason was offered (and accepted, if cancelable);
- raises only publish while visible and idle;
- hidden tabs keep no timer;
- a vetoed tab never rises, and is never stuck at `waiting` while idle and visible;
- `dismiss() === false` means nothing changed;
- a known-bad build is never shown as merely new or stale;
- a dismissed prompt never returns before urgent;
- an urgent snooze is never cut short (to within 3 s of clock rounding).

Twelve deliberate mutations of the core each fail at least one test; nine fail the model test alone. Examples: removing the gate, the stickiness, the hidden-tab check, the veto, decide-before-effects, the reason reports or `declined`; recording dismissals on the client clock; or anchoring the server clock to `Date.now()`.

## The store

```ts
interface AppUpdates {
  getState(): UpdateState // immutable; same object until something changes
  subscribe(listener): () => void // first subscriber starts polling, last one stops it
  addReloadBlocker(blocker): () => void // synchronous: blocker(details) => true blocks
  refresh(): Promise<boolean> // false if blocked or declined; concurrent calls share one reload
  dismiss(): boolean // decides first: true, and effects, only if attention drops
}

type UpdateState =
  | { attention: 'none'; reason: 'unknown' | 'caught-up'; latest?: VersionInfo }
  | {
      attention: 'passive'
      reason: 'new-build' | 'dismiss' | 'waiting' | 'declined'
      latest: VersionInfo
    }
  | { attention: 'prompt'; reason: 'stale'; latest: VersionInfo }
  | {
      attention: 'urgent'
      reason: 'rollback' | 'forced' | 'expired'
      latest: VersionInfo
    }
```

Creating a store has no side effects; it polls only while something is subscribed (`connectPrompt`, a hook, or your own `subscribe()`).

### Options

| Option                          | Default                                                                 | Notes                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `escalation`                    | `{ prompt: { after: "12h" }, urgent: { after: "24h", snooze: "30m" } }` | By build age (server clock). `false` turns a level off. Validated at creation         |
| `onAttentionChange(a, details)` |                                                                         | Told about every attention or reason change; can veto raises and this tab's dismiss   |
| `reload(details)`               | `location.reload()` / `location.assign(href)`                           | _How_ a `refresh`/`navigate` reload happens. See [Reloads](#reloads)                  |
| `subscribeToNavigation`         | unset                                                                   | Opt-in reload on route change; not recommended at a 10–15 min deploy cadence          |
| `pollEvery`                     | `"5m"`                                                                  | Minimum `"10s"`. Visible tabs only; also checks on focus and on return after a minute |
| `idleFor`                       | `"5s"`                                                                  | Input-idle time before raising to prompt/urgent                                       |
| `reloadOnChunkError`            | `true`                                                                  | Reload once on `vite:preloadError`                                                    |
| `storageKey`                    | `"app-version"`                                                         | Set per app if apps share an origin                                                   |

Durations are typed: `` `${number}${"s" | "m" | "h" | "d"}` ``, so `"12 hours"` doesn't compile. The type still admits `"-5m"` and `"1e3s"`, so every duration is also parsed at creation and these throw. Also checked then: `urgent.after` > `prompt.after`, positive snoozes, `pollEvery` ≥ 10 s.

### Attention

| Situation                                           | `attention` (`reason`)  |
| --------------------------------------------------- | ----------------------- |
| Not checked yet                                     | `none` (`unknown`)      |
| Same build                                          | `none` (`caught-up`)    |
| Newer build                                         | `passive` (`new-build`) |
| A raise waiting for an idle, visible tab            | `passive` (`waiting`)   |
| A snooze holding a higher level back                | `passive` (`dismiss`)   |
| `onAttentionChange` canceled a higher level         | `passive` (`declined`)  |
| Running build past `escalation.prompt.after` (12 h) | `prompt` (`stale`)      |
| Running build past `escalation.urgent.after` (24 h) | `urgent` (`expired`)    |
| Latest commit older than ours (rollback), sticky    | `urgent` (`rollback`)   |
| Our build ran before `forceUpdateBefore`, sticky    | `urgent` (`forced`)     |

`forceUpdateBefore` applies even when `latest` is our own version, so rebuilding the same commit with a cutoff forces old tabs.

**Dismissing** works out the result with the snooze in place first; only if attention would drop does it ask `onAttentionChange`, write the snooze and publish exactly that.

| Dismissed                  | Quiet until                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `prompt`                   | `prompt.snooze`, else each tab's own urgent level (one prompt per level), else a day; for tabs already stale |
| `urgent` (expired)         | `urgent.snooze` (30 min); also quiets prompt; for tabs already expired                                       |
| `urgent` (rollback/forced) | `urgent.snooze`, for **our build and the evidence seen**: new deploys don't re-raise it, a new cutoff does   |

### `onAttentionChange` details

Base UI `onOpenChange(open, eventDetails)` shape. `details` is a discriminated union: narrow on `details.attention` to narrow `details.reason`.

| Field        | Meaning                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`     | Why, per level (table above)                                                                                                                                  |
| `previous`   | Attention before the change                                                                                                                                   |
| `source`     | `"check"`, `"time"`, `"user"` (this tab's dismiss), `"other-tab"`: count user dismissals once                                                                 |
| `cancelable` | Only raises and this tab's own dismiss. Lowerings, catching up, reason changes within a level (`previous === attention`) and other tabs' dismissals are facts |
| `cancel()`   | Keep the current attention (`passive` reads `declined`). A canceled raise is offered again after the next successful check                                    |

### Reloads

- **Blockers decide _whether_**, synchronously: `useReloadBlocker` / `addReloadBlocker`. They're the only veto for `chunk-error`, which must be decided before the event returns.
- **`reload` decides _how_** for `refresh` and `navigate`, and may be async. At most one reload runs at a time; concurrent requests share it.

Route it through your router to reuse your navigation blockers. TanStack Router's `navigate({ reloadDocument: true })` runs the app's `useBlocker` blockers before touching `window.location` (verified in its source and against the real router in `packages/core/test/tanstack-reload.browser.test.ts`):

```ts
reload: async ({ href }) => {
  await router.navigate({ href, reloadDocument: true, replace: true });
  return false; // still here afterwards = a blocker stopped it (otherwise the page is unloading)
},
```

For a reload, the router's current and next locations are the same, so block on dirty state (`shouldBlockFn: () => form.isDirty`), not on a pathname change.

### Robustness

- **Fetches:** one at a time via `AbortController` (newest wins, `stop()` aborts, 30 s timeout); malformed `version.json` is ignored.
- **Clock skew:** build age uses the response's `Date` header; cross-origin responses need `Access-Control-Expose-Headers: Date`.
- **Isolation:** throwing listeners, callbacks, blockers and adapters are logged and can't break the store. A throwing blocker counts as blocking.
- **Timers:** capped below the browser's 2^31 ms limit.
- **Chunk-error reload:** at most once per 10 s (timestamp in `sessionStorage`); with sessionStorage blocked it doesn't reload, to rule out loops.
- **Your own `vite:preloadError` handler wins:** if a listener registered before the store subscribes calls `preventDefault()`, the store leaves the event alone. A listener added later can't claim it first; set `reloadOnChunkError: false` to handle chunk errors yourself.

## Prompts: `connectPrompt`

```ts
const disconnect = connectPrompt(appUpdates, {
  minAttention: 'prompt', // optional
  show(prompt) {
    /* create or update your UI, keyed by prompt.id */
  },
  hide() {
    /* remove it */
  },
})
```

`Prompt` is a union (`attention` + its own `reason`) with `id: "app-update"`, `latest`, `refresh(): Promise<boolean>` and `dismiss()`. `connectPrompt` handles: threshold crossing; one `show` per attention/reason change; stale handles whose `dismiss()` is a no-op (wire it to any `onClose`, even one fired by our own `hide()`); `hide()` after a successful dismiss, on whatever state the store actually published; re-showing a refused dismiss; isolated, re-entrancy-safe adapter calls (capped at 5 passes); and keeping the store polling until `disconnect()`. `defaultCopy(prompt)` words a known-bad build differently from an old one.

**Base UI** (tested against real Base UI in `test/react.test.tsx`)

```ts
export const toastManager = Toast.createToastManager() // <Toast.Provider toastManager={toastManager}>

connectPrompt(appUpdates, {
  show: p =>
    toastManager.add({
      id: p.id,
      type: 'app-update',
      timeout: 0,
      priority: p.attention === 'urgent' ? 'high' : 'low',
      title: defaultCopy(p).title,
      description: defaultCopy(p).description,
      actionProps: {
        children: defaultCopy(p).action,
        onClick: () => p.refresh(),
      },
      onClose: p.dismiss,
    }),
  hide: () => toastManager.close('app-update'),
})
```

**Sonner**

```ts
connectPrompt(appUpdates, {
  show: p =>
    toast(defaultCopy(p).title, {
      id: p.id,
      description: defaultCopy(p).description,
      duration: Infinity,
      action: { label: defaultCopy(p).action, onClick: () => p.refresh() },
      onDismiss: p.dismiss,
    }),
  hide: () => toast.dismiss('app-update'),
})
```

**Your own banner store** (from `passive` up): `show: (p) => bannerStore.setState(p)`, `hide: () => bannerStore.setState(null)`.

## Rollbacks

- Dashboard rollback, `wrangler rollback`, or redeploying an old commit: older `commitTime` → `urgent:rollback`, sticky for tabs on the bad build. Needs the commit time at build (`.git`, or `APP_COMMIT_TIME`); without it the plugin warns.
- Revert deployed forward: set `APP_FORCE_UPDATE_BEFORE` to now for that deploy → `urgent:forced`, sticky. Clearing it later doesn't lower tabs that already saw it.
- Tabs on a bad build keep running it until they refresh (R2 still serves its chunks); `urgent` is what moves them.
- Workers gradual deployments can make `version.json` alternate between versions and fake a rollback. Deploy 100% at once.

## Possible next step: server-driven updates

Not built. The API could return `x-min-client-version`, or a known GraphQL error code, and the store would mark the build `forced`, tying urgency to real incompatibility instead of a timer.

## Decisions

### Model the store as an explicit state machine (2026-11-11)

Three review rounds kept finding bugs where rules met (the idle/visible gate, vetoes, re-entrancy, time). Instead of more rules, the store became an explicit machine (model, inputs, a pure policy returning target, hold and deadlines) checked by model-based tests. Specific changes: time is an event (deadlines), known-bad is sticky, vetoes are explicit and re-offered after the next check, only raises and own dismissals are cancelable, offers are atomic, one reload at a time, per-build snoozes for known-bad builds.

### Escalate by build age only; typed thresholds (2026-11-11)

Replaced the local-midnight rule with build age on the server clock (Vercel's 12 h / 24 h defaults). Removes client clock, time zones and DST from the policy; two tabs on the same build agree (to within the `Date` header's 1 s). Thresholds are a typed `escalation` option with `Duration` strings, validated at creation. A prompt dismissal now lasts until the next level starts.

### Snoozes on the server clock, keyed by level; known-bad keyed by evidence (2026-11-11)

The fourth review (of the model) found end times baked in client time: `Date`-header rounding could end a prompt dismissal a second before urgent, and one tab's dismissal ended at its own build's urgent time. Dismissals now record when (server clock) a level was dismissed, and each tab works out its own end. A rollback dismissal was keyed by `latest`, so every deploy re-raised it; it's now keyed by our build plus the evidence seen. The server-clock estimate is anchored to `performance.now()`, so the user's clock jumping moves neither snoozes nor polling. Reason-only changes are now reported (non-cancelable), a vetoed raise reads `passive:declined`, `pollEvery` has a 10 s floor, and `none` says `unknown` before the first check.

### Delegate _how_ to reload to the app (2026-11-11)

A `reload` option performs `refresh`/`navigate` reloads; synchronous blockers still decide whether. One predictable path, async confirmation, and reuse of TanStack Router's blockers. Chunk-error reloads stay on blockers only (they must be decided synchronously).

### `useAppUpdates` returns a deferred value (2026-11-11)

`useSyncExternalStore` updates can't be transitions; Ricky Hanlon (React core) recommended wrapping the read in `useDeferredValue` (reply to Mark Erikson on X, 2026-04-21). Store changes render at transition priority. Actions read the store directly, never the deferred value.

### Keep `onAttentionChange` as one observe-and-veto callback (2026-11-11)

Base UI's `(value, details)` shape, with `details.cancelable` making clear which changes are the app's to veto, and `details.source` separating this tab's user from other tabs.

### Reviews (2026-11-11)

Four independent reviews; every finding is pinned by a test, grouped by the behaviour it protects in `packages/core/test/`.

## Development

A pnpm workspace run by Turbo: `packages/*` are the libraries (built with tsdown), `apps/*` are sample Vite + React apps for Pages and Workers.

| Script              | Runs                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`        | Everything below, in parallel                                                                                       |
| `pnpm build`        | tsdown for each package, then the apps                                                                              |
| `pnpm check:types`  | `tsc` per package and app (plus Workers types for the edge tests)                                                   |
| `pnpm lint`         | oxlint, type-aware, with the vendored anti-slop rules (`tools/oxlint/anti-slop`) and the React Compiler rules       |
| `pnpm format`       | oxfmt (`pnpm check:format` checks)                                                                                  |
| `pnpm test`         | Vitest: Node for everything that doesn't need a browser, Chromium (browser mode) for what does; MSW for the network |
| `pnpm test:edge`    | The emitted worker in workerd, with real R2 and Cloudflare asset serving                                            |
| `pnpm coverage`     | Tests with V8 coverage; each package must reach 95% on lines, branches, functions and statements                    |
| `pnpm check:fallow` | fallow: dead code, duplication, complexity, dependency hygiene                                                      |
