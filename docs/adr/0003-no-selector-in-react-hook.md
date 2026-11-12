# No selector in the React hook

## Context

`useAppUpdates(store, selector?)` followed the Zustand shape. A selector that returned a new object on every call caused render loops, so the hook carried a development warning, a module-level flag so the warning fired once, and a check of `import.meta.env` that only works under Vite.

## Decision

The hook is `useUpdateState(updates)` and returns the whole state. Callers read the field they need, for example `useUpdateState(appUpdates).attention`.

## Consequences

- Snapshots keep their identity until something changes, and that happens a handful of times in a tab's life, so the extra renders a selector would save do not exist in practice.
- The package has no module-level state and no bundler-specific code.
- A component that reads only `attention` also re-renders when `latest` changes at the same attention level. If a profile ever shows that to matter, a selector can be added without breaking this signature.
