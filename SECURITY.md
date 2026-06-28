# Security Policy

`@jagreehal/sandbox-node` is a security tool: it vets `npm`/`pnpm`/`yarn`/`bun` dependencies before
they install (malware, typosquats, the release-age worm window), then runs their lifecycle scripts
inside a Docker/Podman sandbox so they never touch your host credentials, filesystem, or network. That
is the everyday path (`sandbox <pm>`, the per-PM binaries like `spnpm`, or a persistent devcontainer):
vetted AND contained. `sandbox check`/`preflight` vet without a container (no Docker), installing
nothing. Because people rely on that boundary holding, I take reports about it seriously.

## Reducing residual risk: the non-sandboxed host path

`sandbox` contains the commands you put it in front of. The honest residual is everything that
*isn't* sandboxed: a command run without the prefix out of habit, a shell script that calls `npm`
directly, a CI step that forgot the wrapper, or a different tool entirely. Containment can't help a
process that never entered the container — so the goal is to make that path both **rare** and
**worth less if it fires**.

**Make it rare — defense in depth, each layer catching a different actor:**

- **You, interactively:** the per-PM binaries (`sandbox-pnpm` / `spnpm`, …) are the same keystrokes
  as your package manager, vetted then run in a throwaway container. They're thin front-ends for
  `sandbox <pm>`, opt-in by typing the prefix; sandbox never shadows your real `npm`/`pnpm` (a silent
  shell takeover was removed as bad DX). One mode per project: the contained install builds a Linux
  `node_modules`; your own package manager keeps the tree host-native for your IDE.
- **An AI agent:** `sandbox init --agent` adds a `PreToolUse` hook that denies a bare `npm install`
  and tells the agent to re-run it through `sandbox`, plus `permissions.deny` rules for `.env`/`secrets/**`.
- **CI / merges:** `sandbox verify` fails the build unless the repo commits a real boundary, and
  `sandbox --frozen --fail-on-egress npm install` makes the install reproducible and trips the
  build if install-time code phones home.

None of these is itself a containment boundary — they're best-effort nudges around the real
protection (`sandbox` running the command in a container). Which is why the second half matters more.

**Make it worth less — narrow what an un-sandboxed process can reach.** The most valuable thing a
non-sandboxed host process can grab is a long-lived, broadly-scoped credential. Shrink it:

- **Use a fine-grained PAT, not a classic token.** Scope it to the single repository (or a small
  set), not your whole account. A classic `repo`+`admin:*` token in `~/.npmrc` or the environment
  is the worst case; a fine-grained token limited to "contents: read" on one repo is a far smaller
  prize.
- **Drop scopes you don't use.** In particular drop `admin:public_key` (SSH-key management),
  `delete_repo`, and `write:packages`/`write:org` unless a specific job genuinely needs them. A
  publish job needs publish rights; your everyday install token does not.
- **Prefer short-lived, least-privilege credentials over standing ones.** In CI, use OIDC / the
  job's ephemeral `GITHUB_TOKEN` (and set `actions/checkout` `persist-credentials: false` on install
  jobs, so the token isn't written into `.git/config` where install code can read it) rather than a
  long-lived PAT in a secret. Rotate what must persist.
- **Grant secrets to `sandbox` per-run, not ambiently.** `--env NPM_TOKEN` forwards exactly one
  variable for one command; nothing else from your shell enters the container. Keep `egress.allow`
  as narrow as the install allows, so even a granted token can only reach the host it's useful
  against.

The principle: assume a host process *will* occasionally run un-sandboxed, and make sure the
credential it could reach is scoped so tightly that reaching it isn't worth much.

## Responsible disclosure

A responsible disclosure policy protects users from vulnerabilities that are made public
before a fix exists. Vulnerabilities are triaged privately and only disclosed after a
reasonable period that allows a patch to ship and users to upgrade.

Please make a good-faith effort to avoid privacy violations, data loss, and any disruption
to people using the project while you research and report an issue.

## Reporting a vulnerability

If you discover a security vulnerability, please report it **privately** — do not open a
public GitHub issue. Use either of the following:

- **Preferred:** GitHub's private vulnerability reporting — open the repository's
  **Security** tab and choose **Report a vulnerability** (GitHub Security Advisories).
  This keeps the report private and lets us collaborate on a fix and CVE.
- **Email:** [jag.reehal@gmail.com](mailto:jag.reehal@gmail.com). Please include
  `SECURITY: sandbox-node` in the subject line.

When reporting, please include as much of the following as you can:

- the version of `@jagreehal/sandbox-node`, plus your OS and container runtime
  (Docker or Podman) and its version;
- a description of the vulnerability and its impact — in particular, **any way a
  lifecycle script or run command escapes the sandbox** (reaches host credentials,
  the host filesystem outside the workspace, the network when it should be denied,
  or otherwise breaks the documented boundary);
- a minimal reproduction (a sample project, config, or command) and the
  `--json` plan output if relevant.

## What to expect

- I will acknowledge your report within a reasonable time and keep you updated as it is
  triaged and fixed.
- Once a fix is available, I will coordinate a disclosure timeline with you and credit
  your contribution in the release notes and advisory, unless you prefer to remain
  anonymous.

Your efforts to responsibly disclose your findings are sincerely appreciated.
