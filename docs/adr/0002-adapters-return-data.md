# Skew-protection adapters return data and the plugin writes

## Context

An adapter used to have two build hooks and a context object with a logger and a function that failed the build. The Workers adapter created directories and wrote its own file. Testing an adapter needed a real Vite build in a temporary directory, and each adapter had to remember rules such as "never write a worker into the public output".

## Decision

An adapter is a `name` and `files(build)`. It returns client files, private files and warnings, and has no side effects. The plugin emits client files, writes private files relative to the root, logs warnings, and fails the build when a private file would land inside the client output.

## Consequences

- An adapter is tested as a function call.
- Rules about where files may go live once, in the plugin.
- An adapter cannot do work that is not "produce these files", such as calling a provider API during the build. If a host ever needs that, the contract has to grow.
- `ClientBuild` mentions no Vite types, so the same adapters can serve another bundler's plugin entry.
