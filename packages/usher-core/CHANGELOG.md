# @ericchernuka/usher-core

## 0.2.2

### Patch Changes

- b59e07d: Describe what Usher tracks as a running app rather than a tab. This changes the core package description, the API doc comments, and the plugin's error for a forced-update cutoff later than the build.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- a6435a7: The app's updates now say when a refresh is in flight. `appUpdates.refresh.get()` is `true` from the moment `reload` is called until it settles, its subscribers are told when it changes, and `useRefreshing(appUpdates.refresh)` reads it in React, so a refresh button can be disabled while a router reload runs.

  A new `onCheckProblem` option is called when the version file answers with something that is not build facts, once per outage. It receives a `CheckProblem`: the version URL and a `kind` of `http-error`, `not-json` or `not-build-facts`, each with its own detail. Use it to report a deployment whose tabs cannot detect updates.

  `reload` and `onCheckProblem` are now checked when the app's updates are created. A value that is not a function throws there, naming the option, like every other invalid option.

  A connection that drops while the version file is arriving now counts as the network being down. It used to be reported as `not-json`.

- 19d2928: A version check request that fails outright now warns once, the same way a 404 does. Before, a Content-Security-Policy whose `connect-src` did not allow the version URL blocked every check with nothing in the console, and tabs never detected a new deploy.

  The warning appears only when the browser is online and the tab is visible. `onCheckProblem` receives `{ kind: 'request-failed', versionUrl }` for it. Aborted checks, timeouts, an offline browser and a connection that drops partway through the file stay silent as before. A flaky connection the browser still counts as online can report `request-failed`, so filter on `kind` if you only want configuration mistakes.

- 51cd1b3: `createAppUpdates()` now returns the update state and the refresh as two objects, each with its own subscription. This is a breaking change to the object it returns.

  `createAppUpdates()` returns `{ state, refresh }`:

  | Before                               | After                                        |
  | ------------------------------------ | -------------------------------------------- |
  | `appUpdates.getState()`              | `appUpdates.state.get()`                     |
  | `appUpdates.subscribe(fn)`           | `appUpdates.state.subscribe(fn)`             |
  | `appUpdates.dismiss()`               | `appUpdates.state.dismiss()`                 |
  | `appUpdates.refresh()`               | `appUpdates.refresh.run()`                   |
  | `appUpdates.isRefreshing()`          | `appUpdates.refresh.get()`                   |
  | `appUpdates.addRefreshBlocker`       | `appUpdates.refresh.addBlocker`              |
  | `useUpdateState(appUpdates)`         | `useUpdateState(appUpdates.state)`           |
  | `useRefreshing(appUpdates)`          | `useRefreshing(appUpdates.refresh)`          |
  | `useRefreshBlocker(appUpdates, ...)` | `useRefreshBlocker(appUpdates.refresh, ...)` |

  Each behaviour has its own subscription. A listener on `state` no longer runs when a refresh starts or ends; subscribe to `refresh` for that. Reading `useRefreshing` alone no longer starts version checks.

  Options, defaults, the update states and `connectUpdateSurface(appUpdates, surface)` are unchanged.

  New in core: `createUpdateNotice(appUpdates, { minAttention })` gives a declarative surface the notice that `connectUpdateSurface` drives. Every update notice now carries `closable` and `announce`.

  New in React: `useUpdateNotice(appUpdates, { minAttention })` and the headless `UpdateNotice.Root`, `UpdateNotice.Refresh` and `UpdateNotice.Close` parts. `Root` takes an `announcement` prop and announces that wording, politely for a prompt and assertively for urgent attention, through live regions it keeps beside the notice. `Refresh` takes an `action` that receives the refresh to call and runs in a transition.

  `@ericchernuka/react-usher` now needs React 19.2. It uses `useEffectEvent`, `use` and transitions that take async functions.

  New entry `@ericchernuka/usher-core/testing`: `createTestTab()` is a tab with virtual time. Pass it as the second argument to `createAppUpdates`, from core or from `@ericchernuka/usher-plugin/client`, then call `tab.deploy(build)` and `await tab.advance(ms)`.

  `@ericchernuka/usher-core` is now a peer dependency of `@ericchernuka/usher-plugin` and `@ericchernuka/react-usher`. Install it in the app, as the README already said to, so there is one copy.

### Patch Changes

- 321e9e5: Publish the packages under the MIT license.
