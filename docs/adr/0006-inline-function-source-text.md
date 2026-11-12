# Generated code inlines a function's own source text

## Context

Two pieces of code run somewhere other than the module that defines them. The asset fallback handler runs in a generated Cloudflare worker, and the devtools script runs in the page the dev server serves. Both have to arrive as text with no imports: a generated worker must deploy whether or not the deploy step bundles, and an inline script cannot import from the plugin.

Writing them as string templates would lose type checking. Building each as its own entry and reading the built file back would add a build step and a path that has to stay in step with it. The handler is also a public export, for apps that own their Worker, so a template would mean two copies.

## Decision

Each is an ordinary, type-checked function. The generator takes its text with `Function#toString()` and wraps it: the Cloudflare adapters add a default export around `createAssetFallback`, and the plugin calls `installDevtools` with the endpoint URL.

Such a function must be self-contained. It has no imports and refers to nothing outside its own body.

## Consequences

- There is one copy of the handler. The generated worker and the `/worker` export cannot drift.
- Nothing in the types or the lint rules enforces "self-contained". A reference to a module-level helper, or a build that injects helpers into the function body, would produce code that throws on a missing name at runtime.
- Tests stand in for that check. The workerd tests run the generated Pages and Workers files, `check:pack` runs the generated worker from the packed tarball, and the devtools test runs the script the dev server served in a sandbox without the module's scope.
- When to change this: if either function needs a dependency, or grows past what one body can hold, build it as its own entry and embed the built text instead.
