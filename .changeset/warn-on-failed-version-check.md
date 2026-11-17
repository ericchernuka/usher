---
'@rndsqr/usher-core': patch
---

usher now logs a one-time `[usher]` console warning when the version check request fails outright, for example when a Content-Security-Policy `connect-src` rule blocks it or the network is down. Before, only a non-OK response such as a 404 was reported, so update detection stopped with no sign of why.
