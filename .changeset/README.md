# Changesets

This directory is managed by [changesets](https://github.com/changesets/changesets).

Add a changeset for any change that should be released:

```bash
pnpm changeset
```

Pick the bump type (patch / minor / major) and write a short summary. On merge to
`main`, the Release workflow opens a "Version Packages" PR; merging that PR publishes
to npm via OIDC trusted publishing (with provenance), gated by the `release`
environment.
