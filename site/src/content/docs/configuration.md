---
title: Configuration
description: The sandbox.config.json manifest. Presets, egress allowlist, grants, install gates, and the personal local override.
---

`sandbox.config.json` lives at your project root and is committed, so the boundary is the same for everyone. Start it with `sandbox init` (interactive) or `sandbox init --preset balanced`. An editor gets autocomplete from the bundled `sandbox.schema.json`.

## Shape

```json
{
  "$schema": "./sandbox.schema.json",
  "install": {
    "network": "allowlist",
    "frozen": false,
    "minReleaseAgeDays": 0,
    "failOnAdvisory": false,
    "riskHints": "basic",
    "canaries": false
  },
  "run": { "network": "none", "devPorts": false },
  "egress": { "allow": ["registry.npmjs.org"] },
  "grants": { "ssh-agent": false, "claude": "none", "paths": [], "env": [], "envFiles": [] }
}
```

## Egress allowlist

Default-deny means an install reaches only the hosts you list. The first run auto-detects your private registry (from `.npmrc`) and git-dependency hosts. When a `postinstall` is blocked reaching a host, the proxy names it and you choose:

```bash
sandbox allow binaries.prisma.sh        # add one host
sandbox --allow-build-hosts npm install # the curated native-build bundle, this run only
```

Prefer the narrowest fix: one host before the bundle, the bundle before `--full-network`.

## Grants

Everything host-side is denied unless you grant it. Grant the minimum:

- `ssh-agent: true` forwards your SSH agent so git-over-SSH works in the box; the key bytes never enter the container.
- `paths` / `env` / `envFiles` mount specific paths or inject named env vars.
- `claude`: `none`, `project` (a project-local config dir), or `home` (leaky).

:::tip
Prefer `ssh-agent` over mounting a key file, and a project-local Claude config over your home one. A grant is a hole in the boundary; make it as small as the job needs.
:::

## Install gates

These run before any new version is fetched:

- `minReleaseAgeDays`: block versions published in the last N days, the strongest control against publish-and-detonate worms. The `strict` preset sets 7.
- `failOnAdvisory`: block versions flagged as malware in OSV.
- `riskHints`: `off`, `basic` (packument-only), or `thorough` (adds network checks: low downloads, expired maintainer domains).
- `canaries`: plant fake credentials in the install container and watch the egress proxy; if a planted token leaves the box, the run fails as a caught exfiltration.

Any of these can be overridden per run (`--min-release-age 0`, `--fail-on-advisory`, `--risk thorough`).

## The personal override

`sandbox.config.local.json` is git-ignored. It's where `sandbox off` / `sandbox on` write, and where you loosen the boundary just for yourself without changing the team config. Because it's never committed, it can't silently weaken containment for everyone else. `sandbox verify` fails if a committed boundary has been loosened.

## Inspect before you run

```bash
sandbox --dry-run pnpm add zod
```

prints the exact plan (mounts, network mode, allowed hosts, grants, ports) without building or running anything. The fastest way to see what a command would do.
