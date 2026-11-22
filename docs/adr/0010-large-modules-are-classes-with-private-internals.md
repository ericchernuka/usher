# Large modules are classes with `#private` internals

## Context

Core has closure factories (`createServerClock`, `createVisibleTimer`, `createRefresh`, `createPromptDismissal`) and three classes: the store, the latest build and the surface connection. The classes are the modules too large for one function. Each body runs past 100 lines, and the lint rules cap a function at 60.

`createAppUpdates` returns the store's instance. Its fields were public, so an app could reach past the five methods of `AppUpdates` to the environment, the latest build, and state it could overwrite. ADR 0004 keeps the environment internal, yet `appUpdates.env` was there at runtime.

A closure factory would hide all of that and drop the field declarations a class needs. It would also be one function of about 100 lines. That takes either an exception to `max-lines-per-function` for the file, or a split into pieces that each have one caller and exist only to satisfy the rule.

## Decision

A module that fits in one function is a closure factory. A module that does not is a class, and every member outside its interface is `#private`. This holds for every class, including one whose instance never leaves its file, so there is one convention to follow.

We do not add lint exceptions to make a closure fit.

## Consequences

- An app holds the interface and nothing else. For the store that is `getState`, `subscribe`, `refresh`, `dismiss` and `addRefreshBlocker`.
- `#private` holds at runtime. TypeScript's `private` is erased by the build, so it only stops code that is type-checked.
- Tests cannot reach internals either. They already cross the interface, so none changed.
- Classes keep their boilerplate. `erasableSyntaxOnly` rules out parameter properties, so each field is declared and then assigned in the constructor.
- fallow 3.41 does not match coverage data to `#private` members, so it scores their CRAP from its own estimate instead of the measured coverage. Under that estimate a private member fails at a cyclomatic complexity of 10, one below the lint limit. `SurfaceConnection` gained a small `#wanted` member for that reason.
- When to change this: if the function size limit moves, or a class shrinks under it, a factory is the shorter form.
