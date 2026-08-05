# screen-node

**Screen npm, pnpm, yarn, and bun dependencies before they install.** `screen-node`
checks the versions your package manager will fetch for known-bad packages,
typosquats, release age, and deprecation. It then installs them on your host with
the selected package manager.

It is a **fast filter, not a cage.** `screen` names the action: inspect dependencies
before installation and report known risks. Lifecycle scripts run on your
host. Isolate untrusted installs with a security boundary such as
[sandbox-claude](https://github.com/jagreehal/sandbox-claude).

## Install and use

```bash
npm i -g @jagreehal/screen-node
```

The package installs aliases that screen package-manager commands. Add `s` for
screen:

```bash
snpm install            # npm install
spnpm add zod           # pnpm add zod
syarn add react         # yarn add react
sbun add hono           # bun add hono
snpx create-vite app    # npx create-vite app
sbunx vite              # bunx vite
```

You can use the `screen` command with package-manager vocabulary:

```bash
screen install
screen add zod
screen pnpm add zod
```

## Use with Nub

The same package installs a `nub-screen` plugin executable. Nub resolves it when
you put `screen` after `nub`:

```bash
nub screen check zod
nub screen scan
nub screen delta --base origin/main
nub screen secrets
```

Nub checks its resolved graph during installation. It handles OSV malware,
release-age policy, tarball integrity, and lifecycle-script control. screen-node
adds custom malware feeds, typosquat and registry-risk review, dependency-delta
checks, secret scanning, and signed policy verification around that install.

Nub keeps control of installation, execution, and build approval. Review a new
dependency with screen-node, then add it with Nub:

```bash
nub screen check zod && nub add zod
```

Nub dispatches built-ins first. Commands such as `nub screen add` stop with guidance
to use `nub add`. This prevents a Nub-looking command from running another package
manager.

Run the plugin executable directly if your Nub build predates plugin resolution:

```bash
nub-screen check zod
```

## What you get

- Configured malware feeds and project advisories block known-bad packages before
  the package manager fetches them. `screen check` queries OSV. Use the `strict`
  preset or `--fail-on-advisory` to query OSV and block reported malware during an
  install.
- The release-age gate holds back fresh versions during the worm window. Safe
  install can choose the newest older release and show you the substitution.
- Typosquat and deprecation checks flag suspicious or abandoned packages.
- Clean installs stay quiet. Findings name the package, explain the risk, and give
  you a command or config choice.

## Check before you install

Review packages without fetching or installing them:

```bash
screen check zod
screen check express lodash@4
screen check npm install zod
```

Run `screen check` without a package name to inspect dependencies from this
project and its workspaces:

```bash
screen check
screen check ./apps/web/package.json
```

## What you see

A clean check prints a short result:

```console
$ screen check zod
screen: checked 1 package for registry risk hints
screen: preflight: no blocking findings, safe to install
```

A known-bad version stops before the package manager fetches it:

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

Safe install can replace a release inside the worm window with an older version:

```console
$ screen add vite
screen: safe install changed this add:
  installed vite@8.0.16 (pinned exact), not 8.1.0. 8.1.0 is inside the worm window, installed 8.0.16 which predates it (older, more battle-tested, not certified safe)
  take the newest version instead: add --allow-recent vite before the command
```

## Maintain an existing project

```bash
screen scan                       # re-check installed versions for new malware reports
screen delta --base origin/main   # gate dependency changes in a pull request
screen upgrade --write            # update ranges after screening proposed versions
screen secrets                    # fail when the repository contains a credential
screen verify                     # verify committed screen config for CI
screen doctor                     # check config, package manager, registry, and Node
```

`screen upgrade` applies the release-age gate to proposed versions and can select
an older release that has cleared the configured window.

## Checks

- **Known-bad dependencies:** configured feeds and project advisories block the
  install. `screen check` queries OSV; `strict` and `--fail-on-advisory` add that
  OSV gate to installs.
- **Release age:** versions inside the configured worm window block or receive a
  safe-install substitution.
- **Package risk:** typosquats and registry risk signals produce specific findings.
- **Deprecation:** maintainer-deprecated versions block by default.

Full command reference: [`docs/reference.md`](docs/reference.md), or run `screen
help`. Agent workflows: [`skills/screen-install`](skills/screen-install/SKILL.md)
for adding dependencies and [`skills/screen-audit`](skills/screen-audit/SKILL.md)
for auditing and upgrading projects. See [`SECURITY.md`](SECURITY.md) for the
threat model.

## License

Apache-2.0
