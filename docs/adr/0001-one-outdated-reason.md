# One `outdated` reason for every age level

## Context

Update state used to carry three reasons for the same fact: `new-build` at passive attention, `stale` at prompt and `expired` at urgent. Each one meant "a newer build is being served and this tab has not caught up". The only difference was how old the running build was, and `attention` already says that.

## Decision

States reached by escalation share one reason, `outdated`. The reason says why the tab should update: `outdated`, `dismissed`, `rollback` or `forced`. Attention says how loudly to ask.

## Consequences

- Copy that should differ by loudness switches on `attention`, and copy that should differ by cause switches on `reason`. The README recipe does both.
- A surface is shown again when attention changes, not only when reason does, because the connection keys on the pair.
- Telemetry that wants the old three values has to read both fields.
