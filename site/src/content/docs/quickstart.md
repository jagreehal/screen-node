---
title: Quickstart
description: Install the sandbox CLI, run your first gated install with sandbox add, and use check to vet without installing anything.
---

You need a container runtime: Docker Desktop, OrbStack, Podman, or any Docker-compatible engine. That's the only dependency; the CLI builds its own images on first run. macOS and Linux are supported directly; on Windows, run inside WSL2.

## Try it once, no install

```bash
npx @jagreehal/sandbox-node@latest check lodash
```

`check` audits a package against the registry and the OSV advisory database and prints what it finds. It never starts a container and never installs anything, so it's the safest way to see the tool work.

## Install it

```bash
# as a dev dependency (recommended)
npm install -D @jagreehal/sandbox-node
```

That puts `sandbox` on your path. The first contained command builds the sandbox image (a one-time step, around 30 seconds); every contained run after that reuses it.

## Run your first gated install

Use `sandbox add` (or `sandbox install`). It auto-detects your package manager, vets the package, then installs it natively on the host so your IDE gets host-native binaries:

```bash
sandbox add zod            # vet, then install natively on the host
sandbox install            # full install, gated and native by default
sandbox update             # update deps, gated and native by default
sandbox pnpm add zod       # explicit container boundary for this install
```

Before every write, sandbox prints one orient line: package manager, project mode, execution mode.

```
sandbox: pnpm · host-native deps · native
sandbox: gates passed, installing natively on the host so your IDE gets native binaries
```

A clean install stays quiet otherwise. Findings are loud and specific.

:::tip[Expert shortcuts]
Prefer your package manager's own keystrokes? The per-PM binaries are shorter front-ends for the same gated, mode-aware path: `sandbox-pnpm add zod`, or the terse `spnpm add zod` (and `snpm`, `snpx`, `sbun`). Use explicit `sandbox pnpm add zod` when you want the throwaway container boundary.
:::

## One mode per project

`node_modules` is either LOCAL (host-native, from your own `pnpm install` or the native-default sandbox path, so your IDE just works) or CONTAINER (the Linux tree an explicit contained install builds). Never both. sandbox tells them apart by the native binaries in the tree, so before a contained install would replace a host-native tree with a Linux one your IDE can't load, it warns and, on a terminal, asks you to confirm the switch.

For containment and a happy IDE together, generate a devcontainer (`node_modules` lives in a Docker volume, editor and deps run in the box):

```bash
sandbox devcontainer init
```

## Vet without a container

`sandbox check` is the one thing that skips the container. It reviews packages and installs nothing:

```bash
sandbox check some-sketchy-pkg
```

Your real `pnpm` is never shadowed: bare `pnpm`/`npm` always run your own tools. You opt into sandbox by typing the prefix.

:::tip[One-button setup]
`sandbox setup` writes a config if you don't have one, checks your container runtime, builds the images, and prints the next commands, all in one. Add `--vibe` for a dev-focused preset or `--agent` to also harden a coding agent.
:::

## Check your setup any time

```bash
sandbox doctor
```

It reports config, package manager, runtime, daemon, and image state, with a one-line verdict and the exact fix for anything that's off.

## Next

- [How it works](/sandbox-node/how-it-works/): the boundary in detail.
- [What's protected](/sandbox-node/security-model/): and the parts that stay writable.
- [Commands](/sandbox-node/commands/): the full surface.
