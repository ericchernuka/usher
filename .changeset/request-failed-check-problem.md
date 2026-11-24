---
'@ericchernuka/usher-core': minor
---

A version check request that fails outright now warns once, the same way a 404 does. Before, a Content-Security-Policy whose `connect-src` did not allow the version URL blocked every check with nothing in the console, and tabs never detected a new deploy.

The warning appears only when the browser is online and the tab is visible. `onCheckProblem` receives `{ kind: 'request-failed', versionUrl }` for it. Aborted checks, timeouts, an offline browser and a connection that drops partway through the file stay silent as before. A flaky connection the browser still counts as online can report `request-failed`, so filter on `kind` if you only want configuration mistakes.
