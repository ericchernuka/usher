# SPA update continuity

The language for keeping open tabs usable across deployments and asking users to move to the current build.

## Language

**Build**:
The application artifacts produced together from one source version.
_Avoid_: Version when referring to the artifacts.

**Version**:
The source identifier associated with a build. Separate builds can share a version, so it is not a unique build identifier.
_Avoid_: Deployment ID.

**Build facts**:
The version, commit time, and build time that describe a build, with an optional forced-update cutoff from the serving deployment.

**Running build**:
The build already loaded in a tab.
_Avoid_: Current build, which can also mean the deployed build.

**Latest build**:
The build reported by the serving deployment. During a rollback, its source can be older than the running build.
_Avoid_: Newest commit.

**Build time**:
The time a build was produced.
_Avoid_: Built at.

**Commit time**:
The time associated with the source commit, used to order source revisions.
_Avoid_: Build time.

**Outdated since**:
The time from which a tab counts as outdated: the build time of the first build it saw supersede its running build. Later deploys do not move it, and catching up clears it.
_Avoid_: Build age, which counts from the running build's own build time and so punishes a fresh tab on an old build.

**Time outdated**:
The elapsed server time since a tab became outdated. Escalation thresholds are measured in it.
_Avoid_: Build age, session age.

**Chunk**:
A content-hashed JavaScript or CSS asset that a tab can request after its initial page load.

**Skew protection**:
Continued availability of previously shipped chunks across deployments.
_Avoid_: Forced refresh.

**Asset fallback**:
Serving a previously shipped chunk when the current deployment no longer has it.

**Chunk archive**:
The append-only store of every chunk shipped, which asset fallback reads from.
_Avoid_: Build cache.

**Attention**:
The update signal for a tab: none, passive, prompt, or urgent.
_Avoid_: Severity, which can imply an error classification.

**Update state**:
The tab's published attention and reason, together with the latest build it has observed when one is known.

**Outdated**:
The state of a tab whose running build differs from the build being served. Attention says how loudly to ask for a refresh.
_Avoid_: Stale, expired, behind.

**Escalation**:
An increase in attention as a tab's time outdated crosses configured thresholds.
_Avoid_: Age-based escalation.

**Prompt attention**:
A routine request to refresh once a tab has been outdated for the prompt threshold.

**Urgent attention**:
A request to refresh because a tab has been outdated for the urgent threshold, or because of a rollback or a forced update. It cannot be dismissed.

**Prompt dismissal**:
An acknowledgement that quiets prompt attention for eligible tabs. It does not quiet urgent attention.

**Sticky urgency**:
Rollback or forced-update knowledge that a tab keeps until it reloads, even if a later deployment looks fine.
_Avoid_: Known bad.

**Prompt snooze**:
An explicit duration for which a prompt dismissal quiets prompt attention. Urgent attention takes precedence when that duration extends beyond the urgent threshold.

**Rollback**:
A deployment whose source commit is older than the running build's source commit.
_Avoid_: Revert, which can be a new commit.

**Forced-update cutoff**:
The build-time threshold before which running builds require an urgent update. It names a build time, not a deadline, so it is never later than the build that declares it.
_Avoid_: Deadline.

**Update surface**:
The app's presentation of attention, such as a toast, banner, or update button.
_Avoid_: Prompt when the attention level is not meant.

**Update notice**:
What an update surface is asked to show: the update state together with its refresh and close actions.
_Avoid_: Prompt handle.

**Refresh**:
The user's explicit action to move the tab onto the serving deployment.
_Avoid_: Reload for the action.

**Reload**:
The document load a refresh performs. It is the mechanism, which an app can replace, for example to route it through its router.

**Refresh blocker**:
An app decision that prevents a refresh, for example to protect unsaved work.
_Avoid_: Reload blocker.

**Refresh outcome**:
What became of a refresh: reloading, blocked by a refresh blocker, or declined by the reload.
