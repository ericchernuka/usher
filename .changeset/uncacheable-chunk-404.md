---
'@ericchernuka/usher-cloudflare': patch
---

The asset fallback now sends `Cache-Control: no-store` on every 404 for a missing chunk. Without that header, Cloudflare applied the zone's Browser Cache TTL, so a browser that asked for a chunk before it reached the archive kept getting the cached 404 after the chunk arrived. Without an R2 binding, a chunk miss now gets the same uncacheable 404 instead of the static-assets response. A HEAD request for a missing chunk now gets the 404 with no body.
