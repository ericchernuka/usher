---
'@ericchernuka/usher-plugin': minor
---

A build with a skew-protection adapter and a relative `base` (`./` or empty) now fails. A relative base has no fixed URL path for chunks, so the adapter was told the assets live under `./assets/` and wrote routes that never matched. Use an absolute base such as `/`, or a CDN URL.
