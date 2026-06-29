---
name: screen-audit
description: Audit an existing project's dependencies with screen-node and move to safe versions. Scan the declared deps, catch deps that turned malicious after install, gate a PR's dependency changes, and upgrade to vetted releases. Use when auditing a repo's dependencies, reviewing dependency changes in a PR, upgrading packages, or wiring screen into CI.
---

# Audit an existing project with screen-node

`screen` runs supply-chain gates (OSV malware advisories, your feeds and team
advisories, typosquats, the release-age worm window, deprecation) against
dependencies that are already declared or installed. It installs nothing unless you
ask. It is a filter, not a cage: a clean result means "no known-bad signal", not
"proven safe".

This skill covers an existing codebase. To vet and add a *new* package, see
[screen-install](../screen-install/SKILL.md).

## Audit the declared dependencies

```bash
screen check                         # this project's package.json, workspace-aware
screen check ./apps/web/package.json # a specific manifest
```

Reads every declared dependency and prints findings. Installs nothing. Map each
finding to an action (below), then fix the manifest.

## Catch what turned bad after you installed it

```bash
screen scan                          # re-query OSV for your committed lockfile versions
```

A version you trusted last month can be flagged malware today. `scan` exits
non-zero when any installed package is now known-bad. Run it in CI and on a cron.

## Gate a pull request

```bash
screen delta --base origin/main      # gate only the deps this PR adds or bumps
screen secrets                       # fail if the PR commits a credential
screen verify                        # fail unless a real config is committed and unloosened
```

`delta` stays low-noise: it diffs the lockfile against the base ref and gates the
changed packages only, not the whole tree.

## Upgrade to vetted versions

```bash
screen upgrade                       # propose newer ranges (ncu), gate every proposal
screen upgrade --write               # rewrite package.json, then install
```

Scope it with `--minor` / `--patch` / `--target` / `--reject`. When a proposed
version sits inside the worm window, screen substitutes the **next good version**:
the newest stable, non-deprecated release that has already aged past the window.

## Map each finding to an action

- **Malware, known-bad, or typosquat:** do not keep it. Remove or replace the
  package. These hard-block for a reason.
- **Release-age worm window:** take the safe-install substitution, or wait. Exempt a
  specific trusted package with `--allow-recent <name>` only when you know why it is
  fresh.
- **Deprecated:** move to a maintained alternative. Use `--allow-deprecated` only
  when you have accepted the risk.

## CI recipe

```bash
screen check --fail-on-advisory --min-release-age 7   # gate the declared deps
screen scan                                           # retroactive malware sweep
screen delta --base "$GITHUB_BASE_REF"                # gate the PR's changes
screen secrets                                        # credential tripwire
```

Run `screen doctor` to check config, package manager, registry hosts, and Node
state when something looks off.

## When you need a real boundary

screen-node isolates nothing. For code you genuinely do not trust, run inside an
isolated environment ([sandbox-claude](https://github.com/jagreehal/sandbox-claude)).
`screen` runs inside it, so installs are screened *and* contained.
