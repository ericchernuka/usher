# @ericchernuka/usher-cloudflare

## 0.2.2

### Patch Changes

- Updated dependencies [b59e07d]
  - @ericchernuka/usher-plugin@0.2.2

## 0.2.1

### Patch Changes

- 924dfef: The asset fallback now sends `Cache-Control: no-store` on every 404 for a missing chunk. Without that header, Cloudflare applied the zone's Browser Cache TTL, so a browser that asked for a chunk before it reached the archive kept getting the cached 404 after the chunk arrived. Without an R2 binding, a chunk miss now gets the same uncacheable 404 instead of the static-assets response. A HEAD request for a missing chunk now gets the 404 with no body.
- @ericchernuka/usher-plugin@0.2.1

## 0.2.0

### Patch Changes

- 321e9e5: Publish the packages under the MIT license.
- Updated dependencies [4dd9a2e]
- Updated dependencies [321e9e5]
- Updated dependencies [16866d2]
- Updated dependencies [2ae3f48]
- Updated dependencies [51cd1b3]
  - @ericchernuka/usher-plugin@0.2.0
