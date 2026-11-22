# The environment seam stays out of the public interface

## Context

Core reads clocks, timers, fetch, storage, visibility, focus and reload through one `Environment` interface. The tests replace it with a fake tab that has virtual time. Exporting it would let apps inject their own, for example to test update UI or to run somewhere that is not a browser tab.

## Decision

`Environment` and the factory that accepts one are internal. `createAppUpdates(options)` always uses the browser adapter.

## Consequences

- The seam can change shape freely. It already differs from its first design: timers return a cancel function, and a base URL was added.
- There are two adapters, the browser and the test fake, so the seam is real, but both live in this repository.
- Apps that test their update UI fake `AppUpdates`, which has six methods, instead of faking a browser.
- Running outside a browser tab is not supported. If that becomes a goal, exporting the seam is the way in, and its shape then becomes a compatibility promise.
