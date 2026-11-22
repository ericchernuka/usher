# Behaviour-first API: design

Status: implemented. This document says how the client side of Usher is built, what an app can see of it, and why. The [architecture document](Skew%20protection%20architecture.md) lists the modules, [ADR 0012](adr/0012-core-is-built-from-behaviours.md) records the decision, and domain terms are in the [glossary](../GLOSSARY.md).

No decision rule changed in this work. Thresholds, sticky urgency, dismissal, the storage format, the plugin, the adapters and the asset fallback are as they were.

## The idea

[UI SDK](https://ui-sdk.dev/) does not ship a Select. It ships the pieces a Select is made of and builds its own components from them. A behaviour is a small factory with one job, and the finished thing is a composition.

Usher took the layering and left the rest. It is not a component library and has one fixed pipeline: detect a build, decide attention, act on a refresh, present a notice. Core is now built from a behaviour for each stage. It does not export all of them, because a contract nobody has used twice is a guess.

## What the old interface got wrong

`AppUpdates` was one object with six methods and one `subscribe`.

- A listener heard about facts it did not ask for. It ran when a refresh started and ended with the update state unchanged, and a component that only read `useRefreshing` started version checks. [ADR 0011](adr/0011-refreshing-is-store-state-and-a-check-problem-is-a-callback.md) said a seventh method on the same `subscribe` would be the wrong answer.
- The notice rules existed only for imperative surfaces. `connectUpdateSurface` knew that a passive notice closes locally, that a prompt close is a dismissal, and that urgent cannot be closed. A React banner had to work those rules out again.
- An app that tested its update UI faked the six methods by hand and re-encoded the rules in the fake.
- Inside, the store kept sticky urgency and outdated since on behalf of a function that received them back as arguments.

## Public interface

```ts
const appUpdates = createAppUpdates(options)

appUpdates.state.get() // UpdateState
appUpdates.state.subscribe(listener)
appUpdates.state.dismiss()

appUpdates.refresh.get() // whether a refresh is in flight
appUpdates.refresh.subscribe(listener)
appUpdates.refresh.run()
appUpdates.refresh.addBlocker(blocker)
```

The handle is two behaviours, each a `Readable` with its own subscription. A listener on `state` hears about update state. Subscribing to `refresh` starts nothing else.

Around the handle:

- `connectUpdateSurface(appUpdates, surface)` drives an imperative toast or banner. Its signature did not change.
- `createUpdateNotice(appUpdates, { minAttention })` is the notice a surface should show, as a `Readable`. It carries the state, `refresh()`, `close()`, `closable` and `announce`.
- `@rndsqr/react-usher` needs React 19.2. It has a hook per behaviour (`useUpdateState(appUpdates.state)`, `useRefreshing(appUpdates.refresh)`, `useRefreshBlocker(appUpdates.refresh, isDirty)`), `useUpdateNotice`, and the headless `UpdateNotice.Root`, `.Refresh` and `.Close` parts.
- `@rndsqr/usher-core/testing` exports `createTestTab()`, a tab with virtual time. It is passed as the second argument to `createAppUpdates`, and it has `now()`, `deploy(build)` and `advance(ms)`.

Options, defaults and validation messages are unchanged.

## Inside core

```ts
export function createAppUpdates(options, tab = createTab()) {
  return {
    state: createUpdateState(tab, {
      running: options.running,
      latest: createVersionCheck(tab, options),
      signals: [stickyUrgency(), escalation(options)],
      dismissal: createPromptDismissal(tab, options),
    }),
    refresh: createRefresh(tab, options),
  }
}
```

| Behaviour        | Owns                                                             |
| ---------------- | ---------------------------------------------------------------- |
| Tab              | The environment and the server clock                             |
| Version check    | The latest build, the poll schedule, the request, check problems |
| Escalation       | Outdated since                                                   |
| Sticky urgency   | The rollback or forced update last seen                          |
| Prompt dismissal | The shared dismissal time, in memory and in storage              |
| Update state     | The published state and the one deadline timer                   |
| Refresh          | Refresh blockers and the one shared attempt                      |
| Update notice    | The notice shown, and a local close                              |

Each fact has one owner. A behaviour holds timers, listeners and requests only while it has a subscriber, and it subscribes to what it reads only while it has one itself.

### Signals and the update state

A signal is a reason to ask for a refresh. It observes the running and latest builds, remembers what it needs, and when asked returns a claim: an attention and a reason. Beside the claim it can say when its answer may change, and from what time a dismissal applies to it.

The update state evaluates in one pass:

1. No latest build: `none` / `unknown`.
2. Each signal observes the builds and is asked for its claim. No claims: `none` / `caught-up`.
3. A claim that says it is dismissable, with a dismissal at or after that time and inside the prompt snooze if one is set, becomes `passive` / `dismissed`.
4. The loudest claim is published. On a tie the earlier signal in the list wins.
5. One timer is set for the earliest time a claim may change or a snooze ends.

Sticky urgency is one signal and not two, because it keeps one reason: the one last seen, with a forced update ahead of a rollback when one build is both. A tab that saw a forced update and then a rollback says `rollback`. Listing it before escalation puts either reason ahead of an urgent `outdated`. Only escalation's prompt claim says it is dismissable, so urgent attention cannot be dismissed by construction. "A dismissal lasts until urgent" is no longer a special case: the dismissal quiets the prompt claim, and escalation's urgent claim is louder when it arrives.

### Notice and surface

`SurfaceConnection` was split in two. The notice decides what should be shown: the attention threshold, one notice per change of attention or reason, a passive close that holds until the pair changes, a prompt close that dismisses for every tab, and a stale notice whose `close()` does nothing. The connection keeps what exists because imperative libraries misbehave: showing an urgent notice again after the library removed it, the limit of five passes, and isolating a surface that throws.

The React parts read the same notice, so a declarative banner and an imperative toast follow the same rules.

## Headless, with the accessibility rules included

The app owns the markup and the wording. It should not also have to own the accessibility rules, so the parts apply them.

- `Root` renders its element only while there is a notice, with `data-attention` and `data-reason` for styling.
- `Root` takes an `announcement` prop, a function from the notice to the wording a screen reader should hear. Each `Root` keeps a `status` and an `alert` region of its own beside the notice, visually hidden and mounted before there is a notice. When the wording or its priority changes, `Root` empties the region and sets the new wording 100 ms later. Nothing is announced at passive, for empty wording, or for a `Root` given `hidden`, `inert` or `aria-hidden`.
- The regions are rendered where the `Root` is, so they are in the same dialog, portal, shadow tree or document as the notice and are heard wherever it can be. The other side of that is a notice on the page behind an open modal dialog: the page is inert then, so its wording is not heard, and it is not said again when the dialog closes.
- The regions get their hiding styles from an effect and not from a `style` attribute, so server-rendered markup is not left visible under a content security policy that blocks inline styles. Until that effect runs they carry `hidden`, so server-rendered markup gives them no box and nothing shifts when the page hydrates.
- Two `Root`s that give wording for one notice both announce it. The app decides which one speaks by giving the other an empty string.
- The app gives the wording because only the app knows which of its text is the message. An earlier version read it out of the markup inside `Root`, and each review found another case it guessed wrong: text hidden by a style, by `inert` or inside a shadow root, words split across inline elements, a reveal it could not see. Another kept one pair of regions for the whole document and removed duplicates across `Root`s, and each review found a context it sat outside of: an iframe, a modal dialog, two dialogs stacked. A prop and regions beside the notice have none of those cases, and need no observers and no module state.
- A part's own `onClick` runs before the part acts.
- `Refresh` is disabled, with `data-refreshing`, while a refresh is in flight. `Close` renders nothing at urgent.
- `Refresh` takes an `action`, following React's convention for Action props: it receives the refresh to call, runs in a transition the part starts, and keeps the button pending until it settles. Without one, a press refreshes outside any transition, because React holds overlapping transitions in a root pending until all their Actions complete and a slow reload should not do that to an app that did not ask for it.
- The notice is not deferred, though the update state is. A deferred notice can be a stale one, and its Refresh and Close would then act on a notice that is no longer shown. An app that wants the arrival to be a transition can defer what it renders from the notice itself.
- The parts never move focus and never close a notice on a timer.

The first version put `role="status"` or `role="alert"` on `Root`'s own element, which mounts together with its content. A browser test with a virtual screen reader showed that a prompt mounted that way was not announced, while text placed into a region that was already mounted was.

Two libraries were read for how they do this and how they check it:

- UI SDK keeps one polite and one assertive region per document, each with a role, `aria-live` and `aria-atomic`. To announce, it empties the region and sets the text 100 ms later, because a screen reader only notices text that changes after the region exists, and the same text twice only after it was cleared. Its toast announces the title and description and not the actions. It checks announcements with the same virtual screen reader.
- Base UI's toast viewport is a polite region that is already mounted when a toast is added. A high-priority toast is repeated in a visually hidden `role="alert"`. Its tests assert roles and ARIA attributes and do not record speech.

`Root` follows both in keeping its regions mounted before there is wording, and UI SDK in emptying a region and setting new wording 100 ms later and in announcing the message without its controls.

## Why this shape

### Developer experience

- The quick start is still one line, and the hooks kept their names.
- A call site says what it depends on. `useRefreshBlocker(appUpdates.refresh, isDirty)` cannot touch update state.
- A subscription means one thing. A listener on the state or the refresh runs only when that value changed. The notice is the exception: it tells its listeners about every state change, including one that leaves the notice as it was, which is what lets a surface whose `show` threw try again.
- An app tests its update UI against the real rules with `createTestTab()`.

### User experience

- One set of notice rules for every surface. A prompt whose close forgets to dismiss for other tabs, or an urgent notice with a working close button, is no longer something each app can get wrong.
- Announcements come with the parts. Attention maps to politeness: nothing at passive, polite at prompt, assertive at urgent.
- A refresh control that cannot be triggered twice while a slow reload runs.

### Scalability

- A new reason to refresh is a new signal in one file, beside the three that exist. The server-driven signal the one-pager names fits there.
- A new fact for apps to observe is a new `Readable`, not a wider `subscribe`.
- A framework binding adapts `Readable` to the framework's store primitive, once per behaviour.
- Runtime cost holds: one request in flight, one deadline timer, no timers in hidden tabs, and no work without subscribers.

## What is not public, and why

`createTab`, `createVersionCheck`, `createPromptDismissal`, `createUpdateState`, `createRefresh` and the signals are internal. An earlier draft exported all of them, with a `defineSignal` helper and a state type inferred from the signals an app composed.

That was removed. Nobody has written a custom signal, a custom composition or a second source of build facts. The shape a signal returns was settled partly by what TypeScript could infer, and not by a second use. Exported, it would be a promise that costs a breaking release to correct, and it would let an app leave out rollback detection by accident. Unexported, it can change freely.

When the first real need arrives, build it inside core, then export the contract it proved.

## What did not change

- The build plugin, the adapter contract ([ADR 0002](adr/0002-adapters-return-data.md)) and the bundler subpath ([ADR 0008](adr/0008-bundler-is-a-subpath.md)).
- `createAssetFallback`. Splitting it into a current deployment and a chunk archive would be a seam with one adapter, and [ADR 0006](adr/0006-inline-function-source-text.md) needs it to be one self-contained function.
- Simulated deploys. The four modes reach every build fact a signal can read.
- The environment stays private ([ADR 0004](adr/0004-environment-is-internal.md)). The test tab exposes `now`, `deploy` and `advance` and not the seam.

## Costs

- The handle changed shape, so every call site changed: `appUpdates.refresh()` became `appUpdates.refresh.run()`.
- `Readable`, the notice and the test tab are new compatibility promises.
- The attention rules used to be one function that read top to bottom. They are now two signals and a combining step, which needs the five-step list above to follow.
- `UpdateNotice.Root` is the least settled part. Hidden regions, copied text and a delay are more machinery than a role on a `div`, and they have not been heard on a real screen reader.

## Decisions this touches

| ADR                                | Effect                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 0001 One `outdated` reason         | Stands. Each signal owns its reasons.                                                                 |
| 0003 No selector in the React hook | Stands. Each readable is narrow, so there is nothing to select from. The package has no module state. |
| 0004 Environment is internal       | Stands. `/testing` promises `now`, `deploy` and `advance` and not the seam.                           |
| 0005 Escalate from outdated since  | Stands. Outdated since moved from the store into escalation.                                          |
| 0007 Forced-update cutoff          | Stands, inside the sticky urgency signal.                                                             |
| 0010 Classes with `#private`       | Stands for the update state, the notice and the surface connection.                                   |
| 0011 Refreshing is store state     | Superseded in part by ADR 0012. Check problems stay a callback.                                       |
| 0002, 0006, 0008, 0009             | Untouched.                                                                                            |
