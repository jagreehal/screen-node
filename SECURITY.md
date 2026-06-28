# Security model

Read this before trusting `screen-node` with anything. It is deliberately blunt
about what it does and does not protect, because a security claim the code can't
back is itself a bug.

## What screen-node is

A **screening filter** for dependency installs. Before an install fetches anything,
screen-node checks the exact versions it is about to pull against:

- **Known-bad advisories** (OSV malware, plus your own feeds / team advisories) — hard block.
- **Typosquats** of popular packages.
- **The release-age worm window** — brand-new versions that haven't aged, with a safe-install substitution to a vetted recent release.
- **Deprecations.**

If nothing trips, it installs **natively on your host**.

## What screen-node is NOT

**It is a fast filter, not a cage.** This is the single most important thing to
understand:

- **Native installs run lifecycle scripts on your host.** screen-node does not
  isolate anything. A malicious package that passes the heuristics runs
  `postinstall` (and any binary it ships) with **your** user privileges, your
  environment, your credentials, and your filesystem. The gates reduce the odds
  of *fetching* a known-bad package; they do not contain one that slips through.
- **The gates are heuristics.** Advisory feeds have coverage gaps and lag,
  zero-day malware and novel typosquats can slip through, and the release-age
  window is a probability play, not a guarantee.
- **The source tree stays writable.** A malicious install can modify files in
  your working tree; screen-node does not lock or watch it.
- **Global installs are not screened.** `snpm i -g <pkg>` runs on the host
  directly (global bins are host tooling, outside the project tree the gates target).

## When you need a real boundary

When you don't trust the code, run it inside a container with no host credentials
and default-deny egress. That is a different tool:
[sandbox-claude](https://github.com/jagreehal/sandbox-claude) is the cage;
screen-node is the filter. They compose: screen-node can run inside the cage so an
agent's installs are screened *and* contained.

## Reporting a vulnerability

Email jag.reehal+security@gmail.com with details and a reproduction. Please do not
open a public issue for an unpatched vulnerability.
