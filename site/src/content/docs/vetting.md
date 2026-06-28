---
title: Vet a package before installing
description: Use sandbox check to review a package's supply-chain risk without installing it. No container, no Docker.
---

`sandbox check` runs the supply-chain gates over what an install *would* pull and reports every finding **without installing anything**. It needs no container; it queries only the registry and the OSV advisory database, so it's the safe first move before you add a dependency.

## Review without installing

```bash
sandbox check express lodash@4         # bare names, the common case
sandbox check                          # this project's deps (root + every workspace)
sandbox check ./apps/web/package.json  # the deps in a specific manifest
```

`check` always queries OSV, so you see advisories without passing any flag. Add gate flags only when you want a finding to **block** (exit non-zero):

```bash
sandbox --fail-on-advisory --min-release-age 7 --fail-on-risk check left-pad
```

- Exit `0`: nothing blocking. Install when ready.
- Exit `1`: would block. Read the findings below.

## What the findings mean

| Finding | Recommended action |
| --- | --- |
| **Known malware** (`MAL-…`) | Stop. Don't install. Report it. |
| **Deprecated version** | Upgrade to a maintained version. `--allow-deprecated` only if you must. |
| **Release-age violation** | Pin the suggested older version, or exempt with `--allow-recent <pkg>`. |
| **Risk hint** (fresh release, exposed bin) | Often informational; proceed, or pin if it's load-bearing. |
| **Advisory, non-malware** | A heads-up. There's no flag that blocks on it; decide and proceed. |

With `--json`, each blocked package comes with a ready-to-run `pin` command (`sandbox npm add left-pad@1.2.0`).

## Reproducing a committed lockfile? Use `delta`

A bare `check` gates *every* dependency, so an active project trips the release-age gate on packages that are already committed and vetted. That's noise, not new risk. To review only what a change introduces:

```bash
sandbox delta --min-release-age 7 --fail-on-advisory
```

`delta` diffs your lockfile against the merge base (default `origin/main`) and gates only the added or bumped versions. It's the right tool for a pull request. See [Gate dependencies in CI](/sandbox-node/ci/).

:::note[There's a skill for this]
The `sandbox-install` skill drives this whole loop for an AI agent: review with `check`, map each finding to a recommended action, then install with only the overrides you approved. It ships in the package under `skills/`.
:::
