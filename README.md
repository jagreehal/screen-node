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

## Use

Same keystrokes as your package manager, with an `s` prefix (`s` = screen):

```bash
snpm install            # npm install, screened
spnpm add zod           # pnpm add zod, screened
syarn add react         # yarn add react, screened
sbun add hono           # bun add hono, screened
snpx create-vite app    # npx, screened
```

Or inspect without installing:

```bash
screen check            # vet what an install would fetch; install nothing
```

A clean install stays quiet. A finding is loud and specific, and recommends an
action you approve before anything is fetched.

## What it screens

- **Known-bad** dependencies (OSV malware advisories + your own feeds) — hard block.
- **Typosquats** of popular packages.
- **The release-age worm window** — brand-new versions that haven't aged, with a
  safe-install substitution to a vetted recent release.
- **Deprecations.**

## Status

`screen-node` is the gate engine from
[`@jagreehal/sandbox-node`](https://github.com/jagreehal/sandbox-node), repackaged
as a standalone, container-free tool. The inherited Docker/container subsystem
(image build, egress proxy, firewall, devcontainer) has been **removed**: installs
run natively on the host, and the gates are heuristics, not a boundary. Two
follow-ups remain: a `sandbox`→`screen` rename of the log prefix and a few help
strings, and updating `docs/` + `SECURITY.md`, which still describe the old model.

## License

Apache-2.0
