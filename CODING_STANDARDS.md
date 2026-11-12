# Coding standards

## Caches

Treat caches as a design smell. Prefer an architecture that does not need them.

- Give each fact one authoritative owner. Read from that owner or derive the value from its inputs.
- Before adding a cache, simplify data ownership, remove repeated work, and reduce unnecessary computation at its source.
- Review stored derived values as caches, even when they are called snapshots, memoized values, or saved results. Check whether they can drift from their inputs or require invalidation.
- Keep essential state distinct from cached data. A user dismissal or an observed rollback records a fact; a copy of a value that can be derived records duplicate state.
- Propose a cache only with measured evidence that the simpler design cannot meet a concrete requirement. Explain its owner, lifetime, and invalidation rules, and how stale values will be tested.
