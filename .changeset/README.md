# Changesets

Each pull request that changes a published package adds a changeset: a small Markdown file that names the bump (patch, minor or major) and describes the change for the changelog.

```sh
pnpm changeset          # describe a change
pnpm version-packages   # apply pending changesets: bump versions, write changelogs
pnpm release            # build, then publish what changed
```

The four packages are versioned together, so one changeset bumps all of them. The examples are private and are never versioned or published.
