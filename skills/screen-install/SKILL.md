---
name: screen-install
description: Add or install npm/pnpm/yarn/bun dependencies safely with screen-node — review findings first, then install with only the overrides you approved. Use when adding a dependency, running an install, or vetting a package before adopting it.
---

# Safe dependency install with screen-node

`screen` screens the exact versions an install will fetch (OSV malware advisories,
your feeds + team advisories, typosquats, the release-age worm window, deprecation)
**before** anything downloads, then installs natively. It is a filter, not a cage:
lifecycle scripts still run on the host, so treat a clean result as "no known-bad
signal", not "proven safe".

## The loop: review, then install

1. **Review before adding.** Never blind-install a new package.
   ```bash
   screen check <pkg>[@version] ...   # one or more candidates
   screen check                        # this project's deps (workspace-aware)
   ```
   This installs nothing. It prints every finding.

2. **Map each finding to an action** (do not blanket-override):
   - **Malware / known-bad / typosquat** → do not install. Fix the name, or pick a
     different package. These hard-block for a reason.
   - **Release-age worm window** (very recently published) → prefer the safe-install
     substitution to a vetted older version, or wait. Only exempt a specific trusted
     package with `--allow-recent <name>` if you understand why it is fresh.
   - **Deprecated** → choose a maintained alternative; only `--allow-deprecated` if
     you have accepted that risk.
   - **Install/postinstall script or exposed binary** → informational: it will run
     on your host. Decide if you trust this package to run code at install time.

3. **Install with only the overrides you approved.**
   ```bash
   screen add <pkg>            # add a dependency (writes package.json, exact version)
   screen install             # install the project's deps
   spnpm add <pkg>            # same, terse alias (s = screen); also snpm/syarn/sbun
   ```
   Carry forward only the specific flags your review justified (e.g.
   `--allow-recent @myscope/*`), not a broad `--risk off`.

## Useful flags

- `--min-release-age <days>` — block versions newer than N days (worm-window control; strict preset = 7).
- `--fail-on-advisory` — block on any OSV malware flag (good default for unattended/agent runs).
- `--fail-on-risk` — block when any risk hint is found (strictest; for CI).
- `--deep` — extend blocking gates to the full transitive tree (from the lockfile).
- `--frozen` — reproducible install from a committed lockfile (`npm ci` / `--frozen-lockfile`).
- `--dry-run` — print what would run natively, then stop.

## CI / unattended use

- `screen check --fail-on-advisory --min-release-age 7 <pkg>` — gate an addition non-interactively.
- `screen scan` — retroactive sweep: re-flag installed deps that turned malicious after install.
- `screen delta --base origin/main` — gate only the dependency changes a PR introduces.
- `screen secrets` — fail if a credential is committed.
- For an agent install run, prefer `--fail-on-advisory` (and `--allow-all-builds` only
  if you accept unattended build scripts).

## When you need a real boundary

screen-node does not isolate anything. If you genuinely do not trust the code, run
the install inside an isolated environment (e.g.
[sandbox-claude](https://github.com/jagreehal/sandbox-claude)); `screen` can run
inside it so installs are screened *and* contained.
