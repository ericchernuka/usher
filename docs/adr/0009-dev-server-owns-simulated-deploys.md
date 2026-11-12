# The dev server owns simulated deploys, and they are opt-in

## Context

Trying the update flows in development meant replacing `window.fetch` in the console and rewriting responses for `version.json`. That works for one tab until it reloads, has to be redone each time, and skips the real request path, which is part of what is being tried.

The choices were a fetch override built into the browser entry, a panel in the page, or a change on the dev server.

## Decision

With `usher({ devtools: true })`, the dev server holds the build facts it serves: the real ones until a simulated deploy replaces them. `POST <base>__usher/deploy` with a mode of `advance`, `force`, `rollback` or `reset` changes them, and `__USHER_DEVTOOLS__.deploy({ mode })` in the page calls it. The command resolves when the server has changed and does nothing else in the tab.

Each simulated build is derived from the real build, not from the previous simulated one. The build facts embedded in the page are never changed.

The option is off by default. The endpoint accepts only `application/json`.

## Consequences

- A simulated deploy sits where a real one does. Polling, focus checks and other tabs see it through the normal version URL, and the tab notices on its own schedule.
- Deriving from the real build means a forced-update cutoff cannot carry from one simulated deploy into the next.
- Sticky urgency behaves as in production: after `force` or `rollback` a tab stays urgent until it reloads. The tool does not offer a way around that.
- A tab loaded after a simulated deploy still runs the real build, so it is outdated until `reset` or a Vite restart. That is accurate, because a reload in development runs the same code.
- It is opt-in because a tool that changes what the dev server reports should not be present unless someone asked for it. With the option off there is no endpoint and no global, and a production build has neither in any case.
- A page on another origin cannot trigger a deploy: a browser sends JSON across origins only after a preflight, which the dev server does not answer.
- This simulates build facts only. It does not load older code and does not exercise asset fallback.
- There is no panel. A console command covers the need, and a panel would be UI to design and maintain inside other people's apps.
