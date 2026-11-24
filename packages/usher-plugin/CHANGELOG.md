# @ericchernuka/usher-plugin

## 0.2.0

### Minor Changes

- 2ae3f48: A build with a skew-protection adapter and a relative `base` (`./` or empty) now fails. A relative base has no fixed URL path for chunks, so the adapter was told the assets live under `./assets/` and wrote routes that never matched. Use an absolute base such as `/`, or a CDN URL.
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

- 4dd9a2e: `@ericchernuka/usher-plugin/client` now declares the `__USHER_DEVTOOLS__` global that `usher({ devtools: true })` adds in development. It is typed as possibly `undefined`, so an app that puts simulated deploys on buttons no longer has to declare it.
- 321e9e5: Publish the packages under the MIT license.
- 16866d2: An adapter's private file in a directory whose name starts with two dots, such as `dist/..private/worker.js`, was taken to be outside the client output and written there, where it would be served. The build now fails for it like any other private file inside `outDir`.
- Updated dependencies [321e9e5]
- Updated dependencies [a6435a7]
- Updated dependencies [19d2928]
- Updated dependencies [51cd1b3]
  - @ericchernuka/usher-core@0.2.0
