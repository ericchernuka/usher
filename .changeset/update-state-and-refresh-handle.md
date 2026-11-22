---
'@rndsqr/usher-core': minor
'@rndsqr/react-usher': minor
'@rndsqr/usher-plugin': minor
---

`createAppUpdates()` now returns the update state and the refresh as two objects, each with its own subscription. This is a breaking change to the object it returns.

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

New in React: `useUpdateNotice(appUpdates, { minAttention })` and the headless `UpdateNotice.Root`, `UpdateNotice.Refresh` and `UpdateNotice.Close` parts. `Root` announces a prompt politely and an urgent notice assertively through live regions it keeps mounted.

New entry `@rndsqr/usher-core/testing`: `createTestTab()` is a tab with virtual time. Pass it as the second argument to `createAppUpdates`, from core or from `@rndsqr/usher-plugin/client`, then call `tab.deploy(build)` and `await tab.advance(ms)`.
