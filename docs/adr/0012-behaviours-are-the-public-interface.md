# Behaviours are the public interface, and the store is a preset

## Context

`AppUpdates` was one object with six methods. It observed update state, performed refreshes and recorded dismissals, and one `subscribe` reported all of it. [ADR 0011](0011-refreshing-is-store-state-and-a-check-problem-is-a-callback.md) added the sixth method and said the next fact should not go the same way: "Design either a subscription per fact or one snapshot that holds them all."

The attention rules were closed as well. Rollback, forced update and escalation were branches of one function with one hand-written union of reasons, so a new reason to ask for a refresh, such as the server-driven signal the one-pager names, meant editing the function, the store's memory and the union together.

Inside, core was already made of small pieces with one job each. The surface connection was written against the public store alone. [UI SDK](https://ui-sdk.dev/) is built on the same idea taken to the public interface: ship the pieces, and build the finished thing from them with no private access.

## Decision

The public interface of `@rndsqr/usher-core` is its behaviours. Each one that holds a fact is a `Readable` with its own subscription: the version check, the prompt dismissal, the update state, the refresh and the update notice. A reason to refresh is a `Signal`, a description with pure functions, and the update state publishes the loudest claim. `createAppUpdates(options)` is a preset that composes them and returns `{ state, refresh }`.

Layers import only the layers below them through public exports. The React hooks take the behaviour they read. `@rndsqr/usher-core/testing` exports a tab with virtual time.

The build plugin, the adapter contract and the asset fallback handler do not change.

## Consequences

- A listener hears about one fact. Subscribing to `refresh` does not start version checks, and the caveat in ADR 0011 that a listener should compare what it reads is gone.
- A new reason to refresh is a new signal. Its reason joins the state's type, so the compiler lists the copy an app owes.
- Each observed fact has one owner. `rollback()` remembers that a rollback was seen and `escalation()` remembers outdated since, where the store used to hold both for a function that took them back as arguments.
- A declarative React surface and an imperative toast get the same close rules and the same `announce` value from one notice.
- `Readable`, `Signal` and the shape `ask` returns are compatibility promises. The environment stays private ([ADR 0004](0004-environment-is-internal.md)); the test tab promises `deploy` and `advance` and nothing else.
- An app can compose something wrong that the store did not allow, such as leaving out `rollback()`. The preset is the documented default.
- Checks that span behaviours live in the preset. `promptSnooze` with `promptAfter: false` is rejected there and not by a hand-made composition.
- ADR 0011 is superseded where it puts a refresh in flight on the store's `subscribe`. A check problem stays a callback.
- When to change this: if a second fact has to change together with update state in one notification, a subscription per fact cannot express it, and that pair needs one snapshot.

The full design and its justification are in [Behaviour-first API: design](../Behaviour-first%20API%20architecture.md).
