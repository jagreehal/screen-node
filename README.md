# screen-node

**Screen your npm/pnpm/yarn/bun dependencies before they install.** `screen-node`
checks the exact versions an install is about to fetch against known-bad advisories
(OSV malware, your own feeds), typosquats, and the release-age worm window, then
installs natively on your host.

It is a **fast filter, not a cage.** Native installs run lifecycle scripts on your
host, so the gates are heuristics that catch known-bad dependencies early, not a
security boundary. When you need a real boundary, run your work inside a container
(see [sandbox-claude](https://github.com/jagreehal/sandbox-claude)).

## Install

```bash
npm i -g @jagreehal/screen-node
```

## How it works

Every install runs the same path: resolve the exact versions, run the gates, and
only then fetch and install natively. The output is quiet when nothing is wrong and
loud when something is. Three real sessions show the whole behavior.

**A clean package says almost nothing.** This is the common case.

```console
$ screen check zod
screen: checked 1 package for registry risk hints
screen: preflight: no blocking findings, safe to install
```

**A known-bad version is blocked, with the reason and your options.** Nothing is
fetched. You decide; the override is explicit.

```console
$ screen check request
screen: ⚠ request@2.88.2, advisory GHSA-p8p7-x288-28g6
screen: ✖ blocked: a maintainer-deprecated version would be installed; deprecated versions are abandoned and a supply-chain risk
  request@2.88.2, deprecated: request has been deprecated, see https://github.com/request/request/issues/3142
options:
  • upgrade to a non-deprecated version
  • override this once: add --allow-deprecated before the command
screen: ✖ preflight: would BLOCK this install, resolve the findings above, or re-run with an override flag
```

**A brand-new release is swapped for the next good version.** When the latest
version sits inside the worm window (published in the last few days, before anyone
has vetted it), screen pins the newest release that has already aged past the
window and tells you what it changed and how to override.

```console
$ screen add vite
screen: safe install changed this add:
  installed vite@8.0.16 (pinned exact), not 8.1.0. 8.1.0 is inside the worm window, installed 8.0.16 which predates it (older, more battle-tested, not certified safe)
  take the newest version instead: add --allow-recent vite before the command
```

## Screen a new dependency

Same keystrokes as your package manager, with an `s` prefix (`s` = screen):

```bash
snpm install            # npm install, screened
spnpm add zod           # pnpm add zod, screened
syarn add react         # yarn add react, screened
sbun add hono           # bun add hono, screened
snpx create-vite app    # npx, screened
```

Or review first and install nothing:

```bash
screen check zod        # vet one package, print every finding
```

## Audit an existing project

`screen check` with no package name reads your `package.json` (every workspace
package) and runs the declared dependencies through the same gates. Nothing
installs.

```bash
screen check                            # this project's deps, workspace-aware
screen check ./apps/web/package.json    # one manifest
```

`screen upgrade` reuses the next-good-version logic: it proposes newer ranges, gates
every proposal, and pins a vetted release in place of anything still inside the worm
window.

Maintenance and CI gates:

```bash
screen scan                       # re-flag installed deps that turned malicious since install
screen delta --base origin/main   # gate only the dependency changes a PR introduces
screen upgrade --write            # move ranges to newer vetted versions, then install
screen secrets                    # fail if a credential is committed
screen verify                     # CI gate: a real config is committed, no personal layer loosened it
screen doctor                     # check config, package manager, registry, Node state
```

## What it screens

- **Known-bad dependencies** (OSV malware advisories plus your own feeds): hard block.
- **Typosquats** of popular packages.
- **The release-age worm window:** brand-new versions that have not aged, with a
  safe-install substitution to a vetted older release.
- **Deprecations.**

Full command reference: [`docs/reference.md`](docs/reference.md) (or run `screen
help`). Agent workflows: [`skills/screen-install`](skills/screen-install/SKILL.md)
to add a dependency, [`skills/screen-audit`](skills/screen-audit/SKILL.md) to audit
and upgrade an existing project.

## Status

`screen-node` is the gate engine from
[`@jagreehal/sandbox-node`](https://github.com/jagreehal/sandbox-node), repackaged
as a standalone, container-free tool. The inherited Docker/container subsystem
(image build, egress proxy, firewall, devcontainer) is **removed**: installs run
natively on the host, the command and output are branded `screen`, and the gates
are heuristics, not a boundary. See [`SECURITY.md`](SECURITY.md) for the threat
model and [`AGENTS.md`](AGENTS.md) for repo orientation.

The rename to `screen` is complete: env vars use the `SCREEN_*` prefix, on-disk
paths use the `screen` name (`screen.advisories.json`, the `.screen` agent dir),
and the unit plus integration suites pass.

## License

Apache-2.0
