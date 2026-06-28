---
title: Commands
description: The sandbox command surface. The passthrough you already know, plus the sandbox-only commands for setup, vetting, and CI.
---

The default write path: **`sandbox install`, `sandbox add <pkg>`, `sandbox update`.** Each one auto-detects your package manager, vets the target versions, then installs mode-aware: native on a fresh or host-native project, contained when the tree already is container-built. The explicit `sandbox <pm>` form is the contained twin when you want the boundary. Everything below the passthrough table is sugar or a sandbox-only command.

## Passthrough: your package manager, vetted first

sandbox auto-detects npm, pnpm, yarn, or bun and runs the natural command for that project. `sandbox add zod` and `spnpm add zod` vet the target versions, then follow the project's current mode. The explicit `sandbox pnpm add zod` form uses the throwaway container boundary.

| | install | add / remove | update / dedupe | audit | run / exec |
| --- | --- | --- | --- | --- | --- |
| **npm** | `install` · `ci` | `install <pkg>` · `uninstall` | `update` · `dedupe` | `audit` · `audit fix` · `audit signatures` | `run` · `npx` · `x` |
| **pnpm** | `install` | `add` · `remove` | `update` · `dedupe` | `audit` · `audit --fix` | `<script>` · `dlx` · `exec` |
| **yarn** | `install` · bare `yarn` | `add` · `remove` | `up` · `upgrade` · `dedupe` | `audit` | `<script>` · `dlx` |
| **bun** | `install` | `add` · `remove` | `update` | `audit` | `<script>` · `bunx` · `x` |

Anything that pulls a *new* version runs through the supply-chain gates first, then installs. Removing a dependency skips the gates (it fetches nothing).

## Everyday sugar

```bash
sandbox dev               # run dev / start / serve with native PM syntax
sandbox test              # run any package.json script
sandbox x vite            # one-off tool, npx/bunx-style
sandbox script build      # run a script whose name collides with a sandbox command
```

## Expert: per-PM shortcuts

Same gated, mode-aware path, shorter keystrokes. The `sandbox-<pm>` / `s<pm>` binaries mirror your package manager while keeping the gate engine in front.

```bash
sandbox-pnpm add zod      # per-PM front-end: gated, then mode-aware
spnpm add zod             # terse alias for sandbox-pnpm
sandbox pnpm add zod      # explicit throwaway-container boundary
snpm uninstall left-pad   # sandbox-npm
snpx vite                 # sandbox-npx, one-off tool
sbun add hono             # sandbox-bun
```

These never shadow your real `pnpm`/`npm`/`yarn`/`bun`: bare commands run your own tools. You opt into sandbox by typing the prefix.

## Setup and health

| Command | What it does |
| --- | --- |
| `sandbox setup [--vibe \| --agent]` | One-button onboarding: write config, check the runtime, build images, print next steps. |
| `sandbox init [--preset N]` | Write a `sandbox.config.json` from a preset (interactive picker, or `--preset strict\|balanced\|vibe\|agent\|trusted`). |
| `sandbox doctor [--fix]` | Check config, package manager, runtime, daemon, and image state. `--fix` runs the safe remedies. |
| `sandbox devcontainer init` | Generate a `.devcontainer/` from your config: containment and a happy IDE together (`node_modules` in a Docker volume, editor and deps in the box). |
| `sandbox build` | Build (or rebuild) the sandbox and egress-proxy images. |
| `sandbox off` / `on` | Toggle containment for this project (a git-ignored personal override). |

## Vetting and CI

| Command | What it does |
| --- | --- |
| `sandbox check [pkg \| file.json]` | Audit dependencies **before** you install them. No container, no Docker. |
| `sandbox delta [--base <ref>]` | Gate only the dependency changes a PR introduces. |
| `sandbox scan` | Retroactive malware sweep over your committed lockfile (CI/cron). |
| `sandbox secrets [path]` | Offline scan for committed credentials (CI tripwire). |
| `sandbox verify [--scan] [--secrets] [--sign]` | Fail unless the repo commits a real, un-loosened boundary. `--sign` emits a signed receipt. |

## Useful globals

Put these before the command (`sandbox --frozen npm install`):

- `--frozen`: reproducible install; read-only source tree (every PM except pnpm).
- `--min-release-age <days>`: block versions published fewer than N days ago.
- `--fail-on-advisory`: block when a version is flagged as malware.
- `--fail-on-risk`: exit non-zero on any risk hint.
- `--allow-build-hosts`: widen egress to the curated native-build hosts for this run (so a dep can compile in the box).
- `--dry-run`: print the resolved plan (mounts, network, grants) without running anything.
- `--json`: machine-readable output.

Run `sandbox help` for the complete surface.
