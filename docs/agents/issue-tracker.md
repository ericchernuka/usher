# Issue tracker: local Markdown

Issues and specs live under `.scratch/<feature-slug>/`.

- Write the spec in `spec.md`.
- Write one implementation ticket per file under `issues/`, numbered from `01`: `01-<slug>.md`.
- Record triage state in a `Status:` line using the roles in [triage-labels.md](triage-labels.md).
- Record category in a `Category:` line: `bug` or `enhancement`.
- Append discussion under `## Comments`.

When a skill says to publish an issue, create its local file. When it says to fetch a ticket, read the referenced file. Resolve a bare issue number within the named feature; ask for the feature if it is ambiguous.

For wayfinding, keep the effort map in `.scratch/<effort>/map.md`. Child tickets use `Type: research|prototype|grilling|task`, `Status: claimed|resolved`, and optional `Blocked by: NN, NN`. Claim a child before work; resolve it with an `## Answer` and a linked finding in the map. Choose the lowest-numbered open, unblocked, unclaimed child first.
