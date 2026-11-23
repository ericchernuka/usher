# A notice the surface lost is made again, not shown again

## Context

An update notice carries `latest` as it was when the notice was made, and a new notice is made only when attention or reason changes. While the pair holds, later builds reach the update state but not the notice already shown.

`connectUpdateSurface` tells the notice when the surface lost what it was given, through two operations that only it calls:

- `discard`, when `show()` threw. The connection hides the surface, and the notice forgets the one it made, so the next state change makes a new one.
- `renew`, when a library reported an urgent notice closed. The notice makes a new one at once, and the connection shows it.

An architecture review proposed one "surface lost this notice" input that notifies like any other change. It also proposed deleting both operations and letting the connection forget what it showed and show the same notice again. Both break tested behaviour:

- Showing the same notice again shows the build it was made with. After `show()` threw, the retry must show the build served at the time of the retry. After a library closed an urgent toast, the toast must come back with the build served at that moment. `update-surface-misbehaving.test.ts` pins both.
- Making the notice again and notifying at once, after `show()` threw, makes the connection call `show()` again in the same pass. A surface that keeps throwing then runs into the limit of five passes and logs that it keeps re-triggering updates, where it should stay hidden until the state changes.

The two operations differ in when the new notice is made: at the next state change for a surface that threw, at once for a library that closed an urgent toast. That difference belongs to the connection, which knows which of the two happened.

## Decision

The notice keeps `discard` and `renew`, and the connection keeps its own record of what it presented. That record is a different fact from what the notice wants shown. A declarative surface gets only `get` and `subscribe` from `createUpdateNotice`, so the two operations stay off the public interface ([ADR 0010](0010-large-modules-are-classes-with-private-internals.md)).

## Consequences

- The close rules are split: the notice owns them for every surface, and the connection owns recovery from an imperative library that throws or removes its own UI.
- The notice tells its listeners about every state change, even when it shows the same notice, so that a surface whose `show()` threw is asked again. A later tidy-up that notifies only on change would break that retry.
- When to change this: if a notice stops fixing `latest` when it is made, both operations become one, because showing the same notice again would carry the current build.
