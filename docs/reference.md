# screen-node reference

`screen` runs supply-chain gates before an install fetches anything, then installs
natively on the host. It is a fast filter, not a cage: native installs run
lifecycle scripts on your host, so the gates are heuristic screening, not a
boundary. For a real boundary, run untrusted installs in an isolated environment
(see [sandbox-claude](https://github.com/jagreehal/sandbox-claude)).

This reference mirrors `screen help`; run that for the canonical, version-exact text.

## Quick start

```bash
screen check zod        # review a package before you add it (no install)
screen install          # vet, then install natively with the detected PM
screen add zod          # vet, then add a dependency natively
screen update           # vet, then update dependencies natively
screen pnpm add zod     # explicit package manager
```

Every `install` / `add` / `update` / `remove` runs the gates (OSV malware
advisories, your malware feeds + team advisories, typosquats, the release-age worm
window, deprecation) **before** anything is fetched, then installs natively.

## The `s<pm>` aliases

Same gated native path, fewer keystrokes (`s` = screen). Your real `npm`/`pnpm`/
`yarn`/`bun` are never touched.

| alias | long form | runs |
|---|---|---|
| `snpm` | `screen-npm` | npm, gated |
| `spnpm` | `screen-pnpm` | pnpm, gated |
| `syarn` | `screen-yarn` | yarn, gated |
| `sbun` | `screen-bun` | bun, gated |
| `snpx` | `screen-npx` | npx, gated |
| `sbunx` | `screen-bunx` | bunx, gated |

## Review and CI gates (read-only, install nothing)

- **`check [pkg... | file.json | pm cmd]`**: audit packages before you install.
  Queries the registry + OSV and prints every finding. `screen check express
  lodash@4`, `screen check` (this project's deps, workspace-aware), `screen check
  ./apps/web/package.json`, or a full command form. Blocks on malware/known-bad;
  `--min-release-age` / `--fail-on-advisory` / `--fail-on-risk` tighten it for CI.
- **`preflight [pm cmd]`**: alias of `check` that mirrors a specific install command's gates.
- **`scan`**: retroactive malware sweep: re-query OSV for the versions in your
  committed lockfile; exit non-zero if any installed package is now flagged. Run in CI/cron.
- **`delta [--base <ref>]`**: gate only the dependency changes a PR introduces
  (diff the lockfile vs `<ref>`, default `origin/main`). Fast, low-noise PR check.
- **`secrets [path]`**: offline scan for committed credentials. Read-only, redacted, CI tripwire.
- **`verify [--scan] [--secrets] [--sign]`**: exit non-zero unless the repo commits
  a real screen config and no personal layer loosened it (the CI gate behind the badge).
- **`doctor`**: check config, package manager, registry hosts, and Node runtime state.

## Install / write commands

- **`install [pm-args]`**: vet, then install natively with the detected PM.
- **`add <pkg...>`**: add dependency(ies); writes `package.json`, exact versions by default.
- **`remove <pkg...>`**: drop dependency(ies); fetches nothing new (no gate).
- **`update`**: vet, then update within ranges natively.
- **`upgrade [--write]`**: move declared ranges to newer versions (ncu); same gates
  as install; `--write` rewrites `package.json` then installs. `--minor`/`--patch`/`--target`/`--reject`.
- **`x <tool> [args]`**: run a package binary npx/bunx-style (gated).
- **`run -- <cmd...>`**: run a command natively on the host.
- **`approve-builds [pkg]`**: approve dependency build scripts pnpm left ignored.

Explicit pass-through also works: `screen npm install`, `screen pnpm add zod`,
`screen yarn upgrade`, `screen bunx vite`.

## Project shortcuts

- **`dev`**: auto-detect PM, run the first of dev > start > serve from `package.json`.
- **`test`**: auto-detect PM, run a `package.json` script natively.
- **`script <name>`**: run a named script even if it collides with a screen command.

## Config and setup

- **`init [--preset strict|balanced|vibe|agent|trusted]`**: create `screen.config.json`.
- **`setup [--preset N]`** / **`setup --vibe`**: one-button onboarding.
- **`allow <host...>`**: add host(s) to `egress.allow` in `screen.config.json`.
- **`off` / `on`**: toggle the wrapper for this project (writes `screen.config.local.json`,
  your git-ignored personal override). The per-project twin of `SCREEN_OFF=1`.
- **`completion <zsh|bash|fish>`**: print a tab-completion script.
- **`feeds <update|list>`**: manage malware feeds (`install.malwareFeeds`).

## Signing and audit

- **`keygen`**: generate an Ed25519 keypair (private → `SCREEN_SIGNING_KEY`, fingerprint → `SCREEN_TRUSTED_KEY`).
- **`verify --sign`**: emit a signed receipt of the green boundary.
- **`verify-receipt <f>`**: verify a signed receipt; `--fingerprint` / `SCREEN_TRUSTED_KEY` pins the signer.
- **`audit verify <log>`**: verify the hash-chained audit log (`SCREEN_AUDIT_LOG`).
- **`badge [--workflow F]`**: print a markdown "screened" badge.

## Globals (before the command)

| flag | effect |
|---|---|
| `--config <path>` | use a specific `screen.config.json` |
| `--env <NAME>` / `--env-from <path>` | forward host env var(s) for this invocation |
| `--frozen` | reproducible install (`npm ci` / `--frozen-lockfile`) |
| `--risk <off\|basic\|thorough>` | registry risk hints depth |
| `--fail-on-risk` | exit non-zero when risk hints are found |
| `--min-release-age <days>` | block versions published fewer than `<days>` ago (worm-window control) |
| `--allow-recent <pat>` | exempt a name pattern from the release-age gate (repeatable) |
| `--deep` | extend blocking gates to the whole resolved (transitive) tree |
| `--fail-on-advisory` | block when a version is OSV-flagged malware |
| `--allow-deprecated` | allow a maintainer-deprecated version (blocked by default) |
| `--fail-on-source-writes` | exit non-zero if an install edited your source tree |
| `--allow-all-builds` / `--allow-build-hosts` | CI/agent build-script + build-host helpers |
| `--dry-run` / `--json` | print what would run (human / JSON); don't run |
| `--no-update-check` | skip the daily update notice |

## Environment variables

- **`SCREEN_OFF=1`**: run one command (or, exported, a whole shell) straight on the
  host with no screening. (`off: true` in `screen.config.json` does it for the team;
  `screen.config.local.json` for just you.) Screen-only commands keep working either way.
- **`SCREEN_LOG=json`**: NDJSON logs (human lines on stderr by default).
- **`SCREEN_LOG_LEVEL=debug|info|warn|error`**: filter log level.
- **`SCREEN_NPM_REGISTRY`**, **`SCREEN_OSV_API`**: override registry / OSV endpoints.
- **`SCREEN_SIGNING_KEY`**, **`SCREEN_TRUSTED_KEY`**, **`SCREEN_AUDIT_LOG`**: signing / audit.
