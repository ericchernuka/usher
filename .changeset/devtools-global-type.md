---
'@rndsqr/usher-plugin': patch
---

`@rndsqr/usher-plugin/client` now declares the `__USHER_DEVTOOLS__` global that `usher({ devtools: true })` adds in development. It is typed as possibly `undefined`, so an app that puts simulated deploys on buttons no longer has to declare it.
