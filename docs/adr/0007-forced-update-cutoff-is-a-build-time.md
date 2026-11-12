# The forced-update cutoff is a build time, not a deadline

## Context

`APP_FORCE_UPDATE_BUILT_BEFORE` makes tabs urgent after a revert that ships as a new commit, where the commit time cannot show that the old build was bad. It was first named and read as a point in time before which tabs must update, and a tab compared it only with its own build time.

That reading has a failure with no way out. A cutoff set later than the build that declares it also covers that build, so a tab that refreshes onto the fix is still "built before the cutoff" and becomes urgent again. Because urgency from a forced update is sticky, every tab asks for a refresh forever. A cutoff left in the deploy configuration does the same to every later build until someone removes it.

## Decision

The cutoff names a build time: tabs whose build ran before it must update. It applies to a tab only when it is later than the tab's own build time and not later than the build time of the build that serves it.

The plugin fails the build when the cutoff is later than the build's own time, and says to use the time of this build or of the last bad one. Core ignores a cutoff later than the serving build, in case a `version.json` from another tool carries one.

## Consequences

- Refreshing always satisfies a forced update, because the build a tab lands on is never covered by its own cutoff.
- A cutoff that stays in the configuration stops applying once tabs are on a build made after it. It does not need to be removed for correctness.
- There is no way to schedule a forced update for a future time. An app that wants one deploys at that time with the cutoff set to that build.
- The name says "built before" so the value is not mistaken for a deadline. The glossary lists "deadline" as a term to avoid.
- Clearing the cutoff in a later deploy does not lower urgency in tabs that already saw it. That is sticky urgency, not this decision.
