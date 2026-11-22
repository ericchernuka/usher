# A refresh in flight is store state, and a check problem is a callback

## Context

Two things a user can feel were invisible to the app. While a reload ran, nothing said so, and an app that wanted to disable its refresh button kept its own flag. When the version file answered with something that is not build facts, the store logged one warning and otherwise looked like a tab with no update, so a deployment whose tabs could never prompt went unreported.

Both could have gone into the update state. `UpdateState` is the union of attention and reason, a type test pins it to the documented states, and every update notice carries a copy of it. A "refreshing" field would be out of date on a notice as soon as it was shown, and "checks are failing" is not a reason for any attention level: it can be true at all of them.

The refresh flag could also have lived in a React hook. The store already holds the one attempt that concurrent callers share, so a hook with its own flag would be a second owner, and two components could disagree.

## Decision

The store says whether a refresh is in flight. `isRefreshing()` is true from the call to `reload` until it settles, `subscribe` listeners are told when it changes, and `useRefreshing` reads it in React. It is false again after every outcome, including `reloading`. A router can report `reloading` when its own blocker stopped the navigation, and a flag that stayed true would leave the button disabled for good.

A check problem is reported through a function option, `onCheckProblem`, called once per outage with the sentence the console warning prints. It is not state. Nobody shows end users that update checks are failing. The app's use for it is error tracking, and a callback does that without the app subscribing and removing duplicates.

## Consequences

- `AppUpdates` has six methods. An app that fakes it by hand needs `isRefreshing` if it uses `useRefreshing`.
- A `subscribe` listener also runs when a refresh starts and ends, with the update state unchanged. A listener that acts on every call should compare what it reads.
- A component that subscribes only through `useRefreshing` starts polling, like any other subscriber.
- Apps receive the warning's wording, so rewording it changes what they get. Treat the text as written for people, not as something to parse.
- When to change this: a third fact that apps need to observe. A seventh method on the same `subscribe` is the wrong answer then. Design either a subscription per fact or one snapshot that holds them all.
