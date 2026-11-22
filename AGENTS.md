# Repository guide

Before designing, changing, or reviewing code, read [CODING_STANDARDS.md](CODING_STANDARDS.md) and apply its rules.

## Repo map

- `packages/usher-core/`: the build-tool-independent behaviours (version check, signals, dismissal, update state, refresh, update notice), the `createAppUpdates` preset, and the `/testing` tab.
- `packages/usher-plugin/`: the Vite plugin, virtual build metadata, client setup, and the skew-protection adapter contract.
- `packages/react-usher/`: React hooks that each read one behaviour, and headless update notice parts.
- `packages/usher-cloudflare/`: Pages and Workers adapters, the asset fallback handler, and workerd tests.
- `examples/react/cloudflare-pages/` and `examples/react/cloudflare-workers/`: sample Vite apps for the two hosting targets.
- `docs/`: the [SPA one-pager](docs/Skew%20protection%20for%20the%20SPA%20one-pager.md) defines the product goals; the architecture document describes the implementation.
- `tools/`: vendored lint rules, coverage tooling, and the installed-package smoke test.

Package scripts and workspace configuration are the source of truth for commands and build tasks. Read [README.md](README.md) for setup and library usage.

## Agent skills

### Issue tracker

Track issues and specs in local Markdown under `.scratch/`. Read [issue-tracker.md](docs/agents/issue-tracker.md) before creating, fetching, or updating tickets.

### Triage labels

Use the five default triage roles. Read [triage-labels.md](docs/agents/triage-labels.md) before assigning a triage state.

### Domain docs

Use one shared glossary and ADR folder. Read [domain.md](docs/agents/domain.md) before exploring domain behaviour or proposing design changes.
