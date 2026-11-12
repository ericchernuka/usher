# Escalate from when the tab became outdated

## Context

Escalation used to count build age: the time since the running build was made. That measures the wrong thing. A tab opened one minute ago on a six-day-old build went straight to urgent when the next deploy was seen. A team that deploys once a day supersedes a build when it is about 24 hours old, so every open tab skipped passive and prompt and showed a notice that cannot be dismissed, every morning. Teams that deploy weekly got the same on every deploy.

The reason for urgency is how far behind the tab is. The backend has to keep working for old clients, and that window opens when a newer build ships, not when the old one was built.

Anchoring to the latest build's build time fails the other way. Each deploy would restart the count, so a team that deploys every few minutes would never escalate.

## Decision

A tab is outdated since the build time of the first build it saw supersede its running build. That time is never earlier than the running build's own build time. The store keeps it as an observed fact, like sticky urgency. Later deploys do not move it. A response whose version matches the running build clears it, so the count starts over if the tab falls behind again.

`promptAfter` and `urgentAfter` are measured from that time, on the server's clock.

## Consequences

- Deploy frequency does not change the user's experience. Once a week or a hundred times a day, a tab prompts after 12 hours behind and turns urgent after 24.
- A tab that loads an already superseded build, for example from cached HTML, is as outdated as that build is, and can be urgent at once. That is correct: it runs code the backend stopped expecting long ago.
- The estimate errs on the quiet side. A tab that was caught up, then hidden or asleep across several deploys, first sees the newest build and counts from its build time, though it fell behind earlier. Counting from the last time the tab was known to be caught up would err on the loud side: a laptop that slept overnight would be prompted minutes after a deploy. Never nagging is the product's rule, so quiet wins.
- The time lives in memory only. A reload starts on a new build, so there is nothing to persist.
- The glossary term "build age" is retired in favour of "outdated since" and "time outdated".
