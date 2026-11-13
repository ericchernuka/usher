---
'@rndsqr/usher-plugin': patch
---

An adapter's private file in a directory whose name starts with two dots, such as `dist/..private/worker.js`, was taken to be outside the client output and written there, where it would be served. The build now fails for it like any other private file inside `outDir`.
