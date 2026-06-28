---
title: What's protected
description: What sandbox protects by default, what it leaves writable, and how to lock down the rest.
---

The whole sale is trust, so the line stays in plain sight. sandbox blocks credential theft, persistence, and exfiltration. It does not stop a dependency from editing your source tree during an install. Knowing which is which is the point.

## Protected by default

- **Credentials.** No `~/.ssh`, `~/.npmrc`, `~/.aws`, or home directory reaches the container. An install script has nothing of yours to steal.
- **Persistence.** `.git`, `.github`, `.husky`, `.claude`, `.vscode`, and `package.json` are read-only. An install can't plant a git hook, a CI workflow, or a `package.json` script that auto-runs later.
- **Egress.** Default-deny. The install reaches only the registry hosts in your allowlist; everything else is blocked and reported.
- **Capabilities.** `--cap-drop ALL`, `--security-opt no-new-privileges`, and a container-root that is not your host root.

## Not protected by default

:::caution[Your source tree stays writable]
Package managers need a writable project root, so a malicious dependency can overwrite files in `src/` during an install. You'll see it in `git diff`. sandbox stops the install from stealing secrets or persisting; it does not stop it from editing your code.
:::

| What | How to lock it down |
| --- | --- |
| Your **source files** | `--frozen` makes the whole tree read-only (npm, yarn, bun; pnpm keeps a writable root). Review `git diff` after installing from an untrusted source. |
| Anything you **grant** | ssh-agent, paths, env vars, network. Grant the minimum; prefer ssh-agent over mounting key files. |
| **Network in `run` / `shell`** | `run.network` defaults to `none`; widen deliberately with `--dev`. |

We'd rather state this than imply a guarantee the tool can't keep.

## The gradient, by preset

`sandbox init` writes one of five presets, from most to least contained:

| Preset | Posture |
| --- | --- |
| `strict` | Frozen installs, 7-day release-age gate, malware blocking, thorough risk hints, canaries on. CI and untrusted code. |
| `agent` | Blocking release-age gate, canaries on, project-local Claude config, full network for `run`. For repos you hand to a coding agent. |
| `balanced` | The sensible default: native installs, advisory risk hints, container boundary on demand. |
| `vibe` | Dev-friendly: network and common dev ports open for `run`. |
| `trusted` | Full network, ssh-agent, project Claude config. For repos you already trust. |

Tighten any run on the fly with `--min-release-age <days>`, `--fail-on-advisory`, `--fail-on-risk`, or `--frozen`.

## Verify the boundary is real

A boundary that isn't committed, or that a personal override has loosened, isn't a boundary. `sandbox verify` fails unless the repo commits a genuine, un-loosened sandbox boundary. It's the gate behind the "sandboxed" badge. See [Gate dependencies in CI](/sandbox-node/ci/).
