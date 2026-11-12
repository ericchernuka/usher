# Coding standards

## Names

Name every variable, parameter, and import for what it holds. A name is the cheapest place to state intent, so spend it.

- Do not use single-letter names. Write `notice`, `scenario`, or `index`, not `n`, `s`, or `i`. This covers callback parameters, loop counters, destructured values, and namespace imports.
- When two values of the same kind meet, name the difference between them: `next` and `current`, not `a` and `b`.
- Prefer a term from the [glossary](GLOSSARY.md) when one fits.
- The `id-length` lint rule enforces the minimum length. It cannot judge meaning, so a two-letter abbreviation that hides intent is still a defect.

## Caches

Treat caches as a design smell. Prefer an architecture that does not need them.

- Give each fact one authoritative owner. Read from that owner or derive the value from its inputs.
- Before adding a cache, simplify data ownership, remove repeated work, and reduce unnecessary computation at its source.
- Review stored derived values as caches, even when they are called snapshots, memoized values, or saved results. Check whether they can drift from their inputs or require invalidation.
- Keep essential state distinct from cached data. A user dismissal or an observed rollback records a fact; a copy of a value that can be derived records duplicate state.
- Propose a cache only with measured evidence that the simpler design cannot meet a concrete requirement. Explain its owner, lifetime, and invalidation rules, and how stale values will be tested.
