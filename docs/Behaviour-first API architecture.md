# Behaviour-first API: design

Status: implemented. This is the design the client interface was rebuilt to, with the reasons for it. "Today" and "the store" below mean the interface it replaced. The [architecture document](Skew%20protection%20architecture.md) describes the modules, and [ADR 0012](adr/0012-behaviours-are-the-public-interface.md) records the decision.

This document redesigns Usher's public interface around behaviours, in the manner of [UI SDK](https://ui-sdk.dev/). It keeps every feature the library has today and changes no decision rule. Domain terms are in the [glossary](../GLOSSARY.md).

## The idea, and how much of it transfers

UI SDK does not ship a Select. It ships the pieces a Select is made of (`createPopup`, `createSelection`, `createTypeahead`) and builds its own component library from those same pieces, through the public interface. Three properties follow:

1. A behaviour is a small factory with one job, called with a shared context.
2. Higher layers have no private access. The shipped components are compositions anyone could have written.
3. A new component is a new composition, so the library grows by adding pieces, and existing pieces do not change.

Usher is not a component library, so the transfer is partial. What carries over is the layering and the rule that nothing above the behaviours is privileged. What does not carry over is slot and part machinery for arbitrary DOM, or a general kernel for defining primitives. Usher has one domain and a fixed pipeline: detect a build, decide attention, act on a refresh, present a notice. The proposal names the stages of that pipeline and makes each one a public piece.

One fact makes this cheaper than it sounds. Core is already built this way inside. `createServerClock`, `createPromptDismissal`, `createRefresh`, `LatestBuild` and the pure `resolveAttention` are behaviours in all but name, and `connectUpdateSurface` is already written against the public store alone. The proposal moves the public boundary down one level and turns the store into a preset.

## Where the current interface strains

- **One object owns three jobs.** `AppUpdates` observes update state, performs refreshes and records dismissals. [ADR 0011](adr/0011-refreshing-is-store-state-and-a-check-problem-is-a-callback.md) added `isRefreshing` to the same `subscribe` and says what to do next time: "A seventh method on the same `subscribe` is the wrong answer then. Design either a subscription per fact or one snapshot that holds them all."
- **Listeners hear about facts they did not ask for.** A `subscribe` listener runs when a refresh starts and ends with the update state unchanged. A component that only reads `useRefreshing` starts version checks.
- **One options bag configures five modules.** `pollInterval` belongs to the version check, `promptAfter` to escalation, `promptSnooze` and `storageKey` to the dismissal, `reload` to refresh. The bag is flat, so the grouping lives in the README.
- **The attention rules are closed.** Rollback, forced update and escalation are branches of one function, and the reasons are one hand-written union. The one-pager's next step, a server-driven signal such as `x-min-client-version`, means editing that function, the store's memory and the union together.
- **The notice rules exist only for imperative surfaces.** `connectUpdateSurface` knows that a passive notice closes locally, that a prompt close is a dismissal, and that urgent cannot be closed. A React banner rendered from `useUpdateState` has to work those rules out again.

## Layers

```
4  Recipes         toast and banner wiring, copy            (docs and examples)
3  Bindings        React hooks and headless notice parts    (@rndsqr/react-usher)
2  Presets         createAppUpdates(options)                (core, and /client with facts filled in)
1  Behaviours      version check, signals, dismissal,       (@rndsqr/usher-core)
                   update state, refresh, update notice
0  Contracts       Readable, Signal, Tab                    (@rndsqr/usher-core)
```

Each layer imports only the layers below it, through their public exports. Layer 2 is about fifteen lines.

The build plugin, the skew-protection adapter contract and the asset fallback handler are unchanged. See [Build and edge](#build-and-edge).

## Contracts

### Readable

Every behaviour that holds a fact exposes it the same way.

```ts
interface Readable<Value> {
  /** The same value until it changes, so it is safe for useSyncExternalStore. */
  get(): Value
  subscribe(listener: () => void): () => void
}
```

A behaviour holds timers, listeners and requests only while it has a subscriber, and a behaviour that reads another subscribes to it only while it has one itself. This is the lifecycle rule the store has today, applied per behaviour. Subscribing to `refresh` no longer starts version checks, because refresh does not read the latest build.

This is the "subscription per fact" branch of ADR 0011. Each readable is narrow, so [ADR 0003](adr/0003-no-selector-in-react-hook.md) holds without strain: there is nothing to select from.

### Tab

```ts
const tab = createTab()
```

A tab holds the server clock and the environment. Its only public member is `now()`, the server time. Behaviours made by core reach the environment through it. [ADR 0004](adr/0004-environment-is-internal.md) stands: the environment is still not exported.

### Signal

A signal is a reason to ask for a refresh. It is a description with pure functions, and it performs no effects, the same bargain [ADR 0002](adr/0002-adapters-return-data.md) struck for adapters.

```ts
const rollback = () =>
  defineSignal({
    initial: false,
    observe: (seen: boolean, builds) => seen || isRollback(builds),
    ask: seen =>
      seen ? { claim: { attention: 'urgent', reason: 'rollback' } } : undefined,
  })
```

`initial` is what the signal remembers at first, and the update state keeps that memory until the tab reloads. `observe` runs with the running and latest builds and returns the memory. `ask` reads the memory, the builds and the server time, and returns the claim: the attention and reason this signal asks for. Beside the claim it can return `changesAt`, the server time its answer may differ, and `since`, the server time a prompt began. A dismissal is compared with `since`, so a prompt claim without one cannot be dismissed.

Each observed fact gets one owner. Today the store keeps sticky urgency and outdated since on behalf of a function that receives them back as arguments. Here `rollback` owns "this tab saw a rollback" and `escalation` owns outdated since.

## Behaviours

| Behaviour        | Made by                               | Owns                                                         | Gives                                                 |
| ---------------- | ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Version check    | `createVersionCheck(tab, options)`    | Latest build, poll schedule, the request, focus rechecks     | `Readable<BuildFacts \| undefined>`; `onCheckProblem` |
| Escalation       | `escalation(options)`                 | Outdated since                                               | Signal: `outdated` at passive, prompt, urgent         |
| Rollback         | `rollback()`                          | Whether a rollback was seen                                  | Signal: `rollback` at urgent                          |
| Forced update    | `forcedUpdate()`                      | Whether a covering cutoff was seen                           | Signal: `forced` at urgent                            |
| Prompt dismissal | `createPromptDismissal(tab, options)` | The shared dismissal time, in memory and in storage          | `Readable<number \| undefined>`, `record(at)`         |
| Update state     | `createUpdateState(tab, parts)`       | Signal memories, the published state, the one deadline timer | `Readable<UpdateState>`, `dismiss()`                  |
| Refresh          | `createRefresh(tab, options)`         | Refresh blockers, the one shared attempt                     | `Readable<boolean>`, `run()`, `addBlocker()`          |
| Update notice    | `createUpdateNotice(parts, options)`  | The notice shown, and a local close                          | `Readable<UpdateNotice \| undefined>`                 |

Naming follows what the code already does. `create*` makes something stateful that belongs to a tab. A bare noun (`escalation()`, `rollback()`) returns a description, as `cloudflarePages()` does.

### Update state

```ts
const state = createUpdateState(tab, {
  running,
  latest,
  signals: [
    forcedUpdate(),
    rollback(),
    escalation({ promptAfter, urgentAfter }),
  ],
  dismissal,
})
```

One evaluation pass, as today:

1. No latest build: `none` / `unknown`.
2. Each signal claims. No claims: `none` / `caught-up`.
3. A prompt claim whose `since` is at or before the dismissal, and inside the prompt snooze if one is set, becomes `passive` / `dismissed`.
4. The loudest claim is published. On a tie the earlier signal in the list wins.
5. One timer is set for the earliest `changesAt` or snooze expiry.

With the three shipped signals in that order, this produces the table in the README. Forced beats rollback beats an urgent `outdated`, as `detectSticky` orders them now. A forced update applies when the version matches, because it is its own signal and escalation claims nothing. "A dismissal lasts until urgent" is no longer a special case: the dismissal quiets the prompt claim, and escalation's urgent claim is louder when it arrives.

Urgent attention cannot be dismissed by construction. Step 3 only looks at prompt claims.

`state.dismiss()` keeps its contract: `true` only when it lowered a prompt, `false` and no write otherwise. It lives on the update state because "is there a prompt to lower" is a question about state. The dismissal behaviour owns the time and its storage format, which stays `{ "dismissedAt": <ms> }` under `<storageKey>:prompt-dismissal`.

### The state type is inferred from the signals

```ts
// forcedUpdate, rollback, escalation, with a dismissal
type State =
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
```

Each signal declares the pairs of attention and reason it can claim, and `createUpdateState` builds the union. A type-level sketch of these signatures was compiled to check the claim: the preset's inferred type is assignable to today's `UpdateState` and from it, so `update-state-types.test.ts` keeps passing as written. Leave `rollback()` out and `'rollback'` leaves the type. Add a signal and its reason appears, and every exhaustive `switch` over `reason` stops compiling until it has copy for the new case.

### Refresh

`createRefresh(tab, { reload })` is today's `refresh.ts` with a subscription of its own. `run()` resolves `reloading`, `blocked` or `declined`. Blockers are synchronous and run in order, a throwing blocker blocks, concurrent calls share one attempt, and nothing is remembered between calls.

### Update notice

```ts
const notice = createUpdateNotice(
  { state, refresh },
  { minAttention: 'prompt' },
)

notice.get() // undefined, or the state plus refresh(), close(), closable and announce
```

This is the half of `SurfaceConnection` that decides what should be shown: the attention threshold, one notice per change of attention or reason, a passive close that holds until the pair changes, a prompt close that dismisses for every tab, and a stale notice whose `close()` does nothing. `closable` is `false` at urgent.

`announce` says how a screen reader should hear the notice: `'off'` at passive, `'polite'` at prompt and `'assertive'` at urgent. It is on the notice, and not only in the React parts, so an imperative surface can hand it to a toast library that owns its own live region.

`connectUpdateSurface(appUpdates, surface)` keeps its signature and becomes a driver over a notice it makes from the surface's `minAttention`. The driver keeps the parts that exist because imperative libraries misbehave: showing an urgent notice again after the library removed it, the limit of five passes, and isolating a surface that throws.

## The preset

```ts
export function createAppUpdates(options, tab = createTab()) {
  return {
    state: createUpdateState(tab, {
      running: options.running,
      latest: createVersionCheck(tab, options),
      signals: [forcedUpdate(), rollback(), escalation(options)],
      dismissal: createPromptDismissal(tab, options),
    }),
    refresh: createRefresh(tab, options),
  }
}
```

`AppUpdatesOptions` keeps its names, defaults and validation, including the checks that span behaviours, such as `promptSnooze` with `promptAfter: false`. `@rndsqr/usher-plugin/client` still fills in `running` and `versionUrl`. The quick start is the same line it is today:

```ts
export const appUpdates = createAppUpdates()
```

## React

Hooks keep their names and take the behaviour they read, not the whole store.

```tsx
const { attention } = useUpdateState(appUpdates.state)
const refreshing = useRefreshing(appUpdates.refresh)
useRefreshBlocker(appUpdates.refresh, form.formState.isDirty)
```

Two additions sit on the notice behaviour. `useUpdateNotice(appUpdates, { minAttention })` returns the notice for a component that renders its own markup. Headless parts cover the common case:

```tsx
<UpdateNotice.Root updates={appUpdates} minAttention="passive">
  {notice => (
    <>
      <p>{copyFor(notice).title}</p>
      <UpdateNotice.Refresh>Refresh</UpdateNotice.Refresh>
      <UpdateNotice.Close aria-label="Close" />
    </>
  )}
</UpdateNotice.Root>
```

`Root` renders nothing without a notice and sets `data-attention` and `data-reason` for styling. `Refresh` is a button that calls `notice.refresh()` and is disabled, with `data-refreshing`, while a refresh is in flight. `Close` renders nothing when the notice is not closable. The parts ship no styles and no wording.

Headless means the app owns the markup. It should not also have to own the accessibility rules, so the parts apply them and every one can be overridden by a prop:

- `Root` keeps two visually hidden live regions mounted, a `status` and an `alert`, and copies the notice's text into the one that matches `notice.announce`, leaving out the text of buttons. Nothing is announced at passive.
- A notice is announced once. The text is copied when `announce` changes, so a re-render does not repeat it.
- The parts never move focus. A notice must not interrupt typing, at any attention.
- No part closes a notice on a timer.
- `Close` has no default label, since wording is the app's.

The first version put `role="status"` or `role="alert"` on `Root`'s own element, which mounts together with its content. A browser test with a virtual screen reader showed that a prompt mounted that way was not announced, while text placed into a region that was already mounted was. That is why the regions are separate and stay mounted. The test runs in Chromium and WebKit.

Two libraries were read for how they do this and how they check it:

- UI SDK keeps one polite and one assertive region per document, each with a role, `aria-live` and `aria-atomic`. To announce, it empties the region and sets the text 100 ms later, because a screen reader only notices text that changes after the region exists, and the same text twice only after it was cleared. Its toast announces the title and description and not the actions. It checks announcements with the same virtual screen reader, in specs that compare the spoken phrase log.
- Base UI's toast viewport is a polite region that is already mounted when a toast is added. A high-priority toast is repeated in a visually hidden `role="alert"`. Its tests assert the roles and ARIA attributes and do not record speech.

`Root` follows UI SDK on all three points: both attributes beside the role, the empty-then-set delay, and leaving the controls out. Neither library automates a real screen reader, and neither do we. A virtual screen reader follows the specification and is not VoiceOver, NVDA or JAWS, so this is a best guess that matches current practice.

## Testing

`@rndsqr/usher-core/testing` exports a tab with virtual time for apps and for people writing signals:

```ts
const tab = createTestTab()
tab.deploy(nextBuild) // what the version URL now answers
const appUpdates = createAppUpdates({ running, versionUrl }, tab)
await tab.advance(12 * HOUR)
```

An app can then test its notice against the real behaviours, where today it fakes six methods by hand and re-encodes the rules in the fake. The fake environment stays private. Only these driver methods become a promise. A signal needs none of this: it is tested as function calls.

## Build and edge

No change is proposed, and the reasons are worth stating so the idea is not applied by reflex.

- The adapter contract is already data in, files out (ADR 0002), and the bundler is already a subpath ([ADR 0008](adr/0008-bundler-is-a-subpath.md)).
- `createAssetFallback` could be split into "ask the current deployment" and "ask the chunk archive", with R2 as one archive among several. There is one archive today. ADR 0008 declined a bundler abstraction for the same reason: a seam with one adapter is a guess. [ADR 0006](adr/0006-inline-function-source-text.md) also needs the handler to be one self-contained function so generated workers can inline it, which composition from imported pieces would break.
- Simulated deploys keep their four modes. A signal reads only build facts, and `version.json` carries only the fields core knows, so the four modes already reach everything a custom signal can observe. A custom signal is exercised in tests with `tab.deploy(build)`. Devtools need a new mode only once a signal can read an outside fact.

## Where every current feature lives

| Feature today                                                  | After                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| Polling, focus and visibility rechecks, 30-second timeout      | Version check                                          |
| Server clock from the `Date` header                            | Tab, fed by the version check                          |
| `onCheckProblem`, once per outage                              | Version check                                          |
| Outdated since, `promptAfter`, `urgentAfter`                   | `escalation()`                                         |
| Rollback and forced-update detection, sticky urgency           | `rollback()`, `forcedUpdate()`                         |
| Shared dismissal across tabs, `promptSnooze`, `storageKey`     | Prompt dismissal, applied by update state              |
| `getState()`, `subscribe()`, `dismiss()`                       | `appUpdates.state`                                     |
| `refresh()`, `isRefreshing()`, `addRefreshBlocker()`, `reload` | `appUpdates.refresh`: `run()`, `get()`, `addBlocker()` |
| `connectUpdateSurface`, `UpdateNotice`, `minAttention`         | Update notice and its imperative driver                |
| `useUpdateState`, `useRefreshing`, `useRefreshBlocker`         | Same names, behaviour as argument                      |
| `runningBuild`, `createAppUpdates()` from `/client`            | Unchanged                                              |
| Plugin, adapters, asset fallback, devtools                     | Unchanged                                              |

## Why this direction

### Developer experience

- **The first five minutes do not change.** One line creates the preset, and the hooks keep their names. Behaviours are a level a developer drops to, and a team that never does has nothing new to learn.
- **Each call site says what it depends on.** `useRefreshBlocker(appUpdates.refresh, isDirty)` cannot touch update state. A test for a form fakes one behaviour with three members.
- **Options sit beside the code they configure.** The grouping that the README table explains becomes the shape of the interface.
- **The types follow the composition.** Reasons are inferred, so the compiler lists the copy an app owes when a signal is added and stops asking for copy when one is removed.
- **Subscriptions mean one thing.** A listener on `state` hears about state. The caveat in ADR 0011, that a listener should compare what it reads, goes away.
- **Custom rules become a supported path.** Today the answer to "we need our own urgency rule" is a fork or a wrapper store that re-publishes state. A signal is about ten lines and a unit test.

### User experience

The decision rules are the product, and they are untouched: the same thresholds measured from outdated since, the same sticky urgency, no reload that the user did not ask for. The gains are in presentation.

- **One set of notice rules for every surface.** A declarative banner and an imperative toast get the same close semantics from the same behaviour. An urgent notice with a working close button, or a prompt whose close forgets to dismiss for other tabs, stops being something each app can get wrong.
- **Accessible defaults.** Attention maps onto live-region politeness: nothing announced at passive, polite at prompt, assertive at urgent. Each app works this out alone today, or does not.
- **A refresh control that is correct by default.** `UpdateNotice.Refresh` is disabled while a refresh is in flight, so a slow router reload cannot be triggered twice from a stale button.
- **Reasons that match the cause.** A custom signal carries its own reason, so the copy can say "this version is no longer supported" where it would otherwise borrow the wording for `forced`.

There is a risk on this axis too. Composition lets two apps in one organisation ask for refreshes under different rules. The preset is the product's opinion, and the docs should treat leaving it as a decision that needs a reason.

### Scalability

- **The interface grows by addition.** The server-driven signal from the one-pager becomes one new signal:

  ```ts
  const minClientVersion = (supported: Readable<boolean>) =>
    defineSignal({
      name: 'min-client-version',
      watch: supported,
      claim: isSupported =>
        isSupported
          ? undefined
          : { attention: 'urgent', reason: 'unsupported' },
    })
  ```

  Nothing in escalation, the update state or the React package is edited. `watch` is not part of this design. The shipped signals read only builds, so the contract has no way to name an outside fact until a signal needs one. Adding it then breaks nothing.

- **New sources fit the same seam.** Update state reads `Readable<BuildFacts | undefined>`. Build facts pushed over a WebSocket, read from an API response header or shared over a `BroadcastChannel` each implement that interface, and the version check does not learn about any of them.
- **A framework binding is small.** It adapts `Readable` to the framework's store primitive, once per behaviour. Nothing framework-specific can leak into core, because core hands out nothing wider than `Readable`.
- **Work divides along the same lines.** Each behaviour is a file with a contract and its own tests. Two changes to two signals do not meet in one function, which they do in `attention.ts` now.
- **Runtime cost holds.** One request in flight, one deadline timer, no timers in hidden tabs, and no work without subscribers, with the last of these now per behaviour.

This is not a bundle-size argument. Core is small and an app using the preset ships all of it.

## Costs

- **More public surface.** Six methods and one function become eight factories and three contracts. `Signal`, `Claim` and `Readable` are compatibility promises from the day they ship, and the freedom ADR 0004 protects for the environment is given up for those three shapes.
- **Wrong compositions become possible.** An app can omit `rollback()` and miss a rollback, or order signals so a tie goes the other way. The store allows neither. The preset is the defence, and it should stay the documented default.
- **Checks that span behaviours move up.** Escalation and the dismissal no longer see each other's options, so a rule such as "`promptSnooze` needs a prompt level" is enforced by the preset and not by a hand-made composition.
- **Indirection for the reader.** `resolveAttention` can be read top to bottom in one screen. The same rules across three signals and a combining step need the five-step list above to follow.

## Decisions this touches

| ADR                                | Effect                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0001 One `outdated` reason         | Stands. Each signal owns its reasons.                                                                           |
| 0002 Adapters return data          | Stands, and signals follow the same rule.                                                                       |
| 0003 No selector in the React hook | Stands. Narrow readables remove the remaining case for one.                                                     |
| 0004 Environment is internal       | Stands. `/testing` promises a few driver methods and not the seam.                                              |
| 0005 Escalate from outdated since  | Stands. Outdated since moves from the store into `escalation()`.                                                |
| 0007 Forced-update cutoff          | Stands, inside `forcedUpdate()`.                                                                                |
| 0010 Classes with `#private`       | Stands for update state and the notice.                                                                         |
| 0011 Refreshing is store state     | Superseded in part by ADR 0012, by the route it names: a subscription per fact. Check problems stay a callback. |
| 0006, 0008, 0009                   | Untouched.                                                                                                      |

The glossary gains **Behaviour**, **Signal** and **Claim**.

## Decided

- **No backwards compatibility.** Nothing depends on the current interface, so the new one replaces it in one release. The flat `AppUpdates` methods, the store class behind them and the surface's own `minAttention` are deleted, with no deprecated forwards.
- **Nothing ships ahead of a need.** `defineSignal` has `name`, `initial`, `observe` and `claim`. `watch` waits for the first signal that reads an outside fact.
- **`/testing` ships with the first release.**
- **The parts carry the accessibility defaults.** Headless covers markup and styling. Roles, focus and announcement rules come from the notice and can be overridden.
- **Devtools do not change.** See [Build and edge](#build-and-edge).

## What changed while building it

- **The tab does not hold the running build.** Only the update state reads it, so `running` is one of its parts and `createTab()` takes nothing. This is also what lets a test tab be passed to `createAppUpdates(options, tab)`.
- **A signal's `ask` returns the claim beside its timing**, as `{ claim, since, changesAt }`. The state is the claim plus the latest build, and keeping them apart lets the state type be built from the signals without a type assertion. Signals have no `name`, because nothing read it.
- **`connectUpdateSurface` kept `(appUpdates, surface)`** with `minAttention` on the surface. One call is simpler for an app than making a notice first, and `createUpdateNotice` is there for a declarative surface.
- **The preset's state type is the hand-written `UpdateState` union.** A custom composition gets an inferred type. The two are assignable to each other, and the written one reads better in an editor.
- **`UpdateNotice.Close` does not warn about a missing label.** A development-only warning needs a bundler flag, which [ADR 0003](adr/0003-no-selector-in-react-hook.md) removed from the React package.
- **The notice tells its subscribers about every state change**, including one that leaves the notice as it was. That is what retries a surface whose `show` threw.
