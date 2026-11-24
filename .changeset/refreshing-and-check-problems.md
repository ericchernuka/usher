---
'@ericchernuka/usher-core': minor
'@ericchernuka/react-usher': minor
---

The app's updates now say when a refresh is in flight. `appUpdates.refresh.get()` is `true` from the moment `reload` is called until it settles, its subscribers are told when it changes, and `useRefreshing(appUpdates.refresh)` reads it in React, so a refresh button can be disabled while a router reload runs.

A new `onCheckProblem` option is called when the version file answers with something that is not build facts, once per outage. It receives a `CheckProblem`: the version URL and a `kind` of `http-error`, `not-json` or `not-build-facts`, each with its own detail. Use it to report a deployment whose tabs cannot detect updates.

`reload` and `onCheckProblem` are now checked when the app's updates are created. A value that is not a function throws there, naming the option, like every other invalid option.

A connection that drops while the version file is arriving now counts as the network being down. It used to be reported as `not-json`.
