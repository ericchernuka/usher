# Core is built from behaviours, and exports only the ones with a proven use

## Context

`AppUpdates` was one object with six methods. It observed update state, performed refreshes and recorded dismissals, and one `subscribe` reported all of it. [ADR 0011](0011-refreshing-is-store-state-and-a-check-problem-is-a-callback.md) added the sixth method and said the next fact should not go the same way: "Design either a subscription per fact or one snapshot that holds them all."

The attention rules were closed as well. Rollback, forced update and escalation were branches of one function with one hand-written union of reasons.

[UI SDK](https://ui-sdk.dev/) ships small behaviours and builds its components from them with no private access. Core was already made of such pieces inside, so the same layering was available here.

Two questions had to be kept apart: how core is built, and how much of that an app can see. A custom signal, a custom composition and a second source of build facts are all plausible, and none exists. A contract exported before its second use is a guess that costs a breaking release to correct.

## Decision

Core is built from behaviours. Each one that holds a fact is a `Readable` with its own subscription: the version check, the prompt dismissal, the update state, the refresh and the update notice. A reason to refresh is a signal, which remembers what it has seen and makes a claim, and the update state publishes the loudest claim. `createAppUpdates(options)` composes them.

The public interface is the part with a use today:

- `createAppUpdates()` returns `{ state, refresh }`, the two behaviours an app reads and acts on.
- `createUpdateNotice()` and `connectUpdateSurface()`, for declarative and imperative surfaces.
- `@rndsqr/usher-core/testing` exports a tab with virtual time.

`createTab`, `createVersionCheck`, `createPromptDismissal`, `createUpdateState`, `createRefresh` and the signals are internal. There is one composition, so the state type is the written `UpdateState` union and nothing is inferred from the signals.

The build plugin, the adapter contract and the asset fallback handler do not change.

## Consequences

- A listener hears about one fact. Subscribing to `refresh` does not start version checks, and the caveat in ADR 0011 that a listener should compare what it reads is gone.
- A declarative React surface and an imperative toast get the same close rules and the same `announce` value from one notice.
- Each observed fact has one owner. The rollback signal remembers that a rollback was seen and escalation remembers outdated since, where the store used to hold both for a function that took them back as arguments.
- An app cannot compose something wrong, such as leaving out rollback detection, because it cannot compose.
- The signal contract can change freely. Tests cross the public interface, so they do not pin it either.
- A tab is recognised by identity, so a test tab only works with the copy of core that made it. Core is a peer dependency of the plugin and the React package to keep that to one copy, and the error names the cause when it is not.
- The environment stays private ([ADR 0004](0004-environment-is-internal.md)); the test tab promises `deploy` and `advance` and nothing else.
- ADR 0011 is superseded where it puts a refresh in flight on the store's `subscribe`. A check problem stays a callback.
- When to change this: the first real need for a custom signal or source, such as the server-driven signal the one-pager names. Build it inside core first, then export the contract it proved.

The full design and its justification are in [Behaviour-first API: design](../Behaviour-first%20API%20architecture.md).
