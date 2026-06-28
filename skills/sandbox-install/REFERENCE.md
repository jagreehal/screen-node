# sandbox-install reference

CLI: `@jagreehal/sandbox-node` (binaries: `sandbox`, `sandbox-node`).

## Script commands

For `package.json` scripts, the preferred form is:

- `sandbox dev`
- `sandbox test`
- `sandbox lint`

The CLI picks the package manager from `package.json#packageManager` when present, else from the
lockfile. It then runs the script with the native syntax for that manager. When a script name
collides with a sandbox command such as `build`, use `sandbox script build`.

## `check` / `preflight` command (the review pass)

```
sandbox [gate flags] check  [pkgs… | file.json | <pm> <cmd> …]
sandbox [gate flags] preflight [<pm> <cmd> …]
```

Runs the same gates as a real install but **never installs**, and needs **no Docker**: it only
queries the registry + OSV. Reports findings and exits non-zero when the matching install would have
been blocked. `check` always queries OSV (so advisories show without `--fail-on-advisory`; that flag
only makes them *block*). `preflight` is the command-mirroring sibling.

- `sandbox check express lodash@4`: bare package names (the direct package-name form)
- `sandbox check`: the whole project: root manifest **+ every workspace package.json**, deduped
- `sandbox check ./packages/api/package.json`: the deps in a specific manifest (workspace-aware for
  a `package.json`; relative paths resolve from the current directory)
- `sandbox --min-release-age 7 check npm install`: check a plain install (command form)
- `sandbox --fail-on-advisory preflight pnpm add zod`: check what adding `zod` would pull
- `sandbox preflight npx cowsay`: check the package a fetch-and-run would execute

Exit codes: **0** = no blocking findings (safe to install); **1** = would block.

### `--json` report shape

```json
{
  "blocked": true,
  "checked": 1,
  "deepChecked": 0,
  "hints": [ { "code": "recent_version", "package": "left-pad", "version": "1.3.0", "...": "" } ],
  "ageViolations": [ { "name": "left-pad", "version": "1.3.0", "publishedAt": "…", "ageDays": 0 } ],
  "advisoryHits": [ { "name": "…", "version": "…", "ids": ["MAL-…"], "malware": true } ],
  "deprecations": [ { "name": "old-lib", "version": "2.0.0", "reason": "no longer maintained" } ],
  "suggestions": [ { "name": "left-pad", "version": "1.2.0", "pin": "sandbox npm add left-pad@1.2.0", "ageDays": 159 } ]
}
```

For each release-age violation, `suggestions[]` names the newest **stable, non-deprecated,
already-aged-in** version and gives a ready-to-run `pin` command. Empty when no older
version qualifies (then recommend waiting or `--allow-recent`).

### Annotated `--json` example

Real preflight from `sandbox --json --fail-on-risk --fail-on-advisory --min-release-age 7 preflight npm install left-pad` where `left-pad@1.3.0` was published 2 hours ago:

```json
{
  "blocked": true,
  "checked": 1,
  "deepChecked": 0,
  "hints": [
    {
      "code": "recent_version",
      "package": "left-pad",
      "version": "1.3.0",
      "severity": "warn",
      "message": "published 2 hours ago, install still contained"
    }
  ],
  "ageViolations": [
    {
      "name": "left-pad",
      "version": "1.3.0",
      "publishedAt": "2026-06-12T08:30:00.000Z",
      "ageDays": 0
    }
  ],
  "advisoryHits": [],
  "deprecations": [],
  "suggestions": [
    {
      "name": "left-pad",
      "version": "1.2.0",
      "pin": "sandbox npm add left-pad@1.2.0",
      "ageDays": 159
    }
  ]
}
```

**How agents read this:**
- `blocked: true` → the install would have been refused; do NOT proceed without user approval
- `ageViolations[]` → each is a version blocked by the release-age gate; use `suggestions[]` for a safe pin
- `advisoryHits[]` → if `malware: true`, **abort** immediately (do not offer to proceed); otherwise surface advisory IDs as info
- `suggestions[]` → ready-to-run `pin` commands; prefer the narrowest override (`--allow-recent <pkg>`) over blanket (`--min-release-age 0`)
- `deprecations[]` → maintainer-deprecated; blocks by default, re-run with `--allow-deprecated` only if the user insists

## The gates (check / preflight)

The preflight resolves the registry once and runs every active gate over that result. It
runs *before* the install and decides the exit code. Blocking precedence:

1. **Release-age gate:** blocks a version published fewer than N days ago. The strongest
   control against publish-and-detonate worms.
2. **Known-malware advisory:** OSV advisory with a `MAL-…` id; blocks under
   `--fail-on-advisory`. **Non-malware advisories are logged as warnings only and never
   block**; no flag blocks on them.
3. **Deprecated version:** a version the maintainer marked deprecated. **Blocks by default**
   (deprecated = abandoned = supply-chain risk); `--allow-deprecated` downgrades it to a
   warning. Rides on the risk resolution, so `--risk off` also disables it.
4. **Risk hints:** advisory by default; blocks only under `--fail-on-risk`.

Precedence when several fire: release-age → malware → deprecated → risk hints.

**Monorepos:** the direct-deps gates (deprecated, malware, risk hints) check the **union of every
workspace package's deps** (npm/yarn/bun `workspaces` or `pnpm-workspace.yaml`), not just the root
manifest, because `install` at the root pulls them all. Local `workspace:`/`file:`/`link:` deps are
skipped (nothing to fetch).

**`--deep`** extends the **blocking** gates (release-age, **deprecated**, and **malware** with
`--fail-on-advisory`) to the whole transitive tree from the lockfile, at the **exact locked
versions** (so it catches the version actually installed, not the latest the range resolves to). It
reads one packument per package (age + deprecation come from the same fetch) plus OSV queries for
malware. Risk *hints* (bin/script/recent) stay direct-only; they're advisory, not worth tree-wide.

Everything **fails open**: a registry/OSV lookup error proceeds inside containment rather
than wedging the install.

## `upgrade` command (move ranges to newer versions)

`sandbox npm update` only moves deps *within* their declared range. To bump the ranges themselves
(including majors) use `sandbox upgrade`, which wraps `npm-check-updates`. Key points for an agent:

- The config's `minReleaseAgeDays` becomes ncu's `--cooldown`, so proposals already exclude
  fresh publishes. The proposed versions then run through the **same gates as install**
  (release-age, malware, deprecation, risk), so `upgrade` carries identical guarantees.
- **No write without passing the gates.** Default is a preview table, with `package.json` untouched.
  A blocked proposal aborts the write and prints the same pin suggestions as a blocked install.
- `--write` applies the previewed, gated versions to `package.json` (sandbox writes them, not ncu,
  so you get exactly what you reviewed), then runs the install **in the jail** to refresh the
  lockfile. ncu reads `package.json` and queries the registry but never runs package code, so
  discovery stays on the host.
- Scope the jump: `--minor` / `--patch` / `--target <latest|minor|patch|newest|greatest|semver>`.
  Skip a package: `--reject <pattern>`. Skip the TTY confirm: `--yes`. Machine-readable: `--json`.
- Exit code: `0` (applied, nothing to do, or clean preview), `1` (a proposal hit a gate, nothing
  written). On `--json`, `blocked: true` means do not proceed without user approval.

## Write commands (the default path)

The write path leads with three commands; sandbox auto-detects the package manager from the project,
so you don't name it. Each vets the targets with the gate engine, then installs mode-aware: native on a
host-native or fresh project, contained when the tree is already a container build. Before each write
the CLI prints one line saying what's about to happen and why:
`installing natively on the host with pnpm (host-native deps; gates ran, no container boundary)` or
`installing in a throwaway container with pnpm (container-built deps; no host creds, default-deny egress)`.
A native install runs lifecycle scripts on the host, so the gates are heuristics, not a boundary; the
container is the boundary.

- `sandbox install [pkgs]`: install (or add the named packages) through the mode-aware write path.
- `sandbox add <pkg...>`: add dependencies, saved as exact versions by default; this is where safe
  install (above) applies.
- `sandbox update`: update existing deps within their declared ranges. To move the ranges themselves,
  use `sandbox upgrade` (above).
- `sandbox remove <pkg...>`: uninstall. Fetches nothing new, so there's no gate surface, but it still
  runs through sandbox.

## Expert: per-PM binaries (same mode-aware path, shorter keystrokes)

For a human who lives in their package manager's muscle memory, the per-PM binaries take the same
mode-aware path without the `sandbox` prefix or the auto-detect step, instead of shadowing their
shell's `npm`/`pnpm` (which is bad DX). `sandbox-pnpm add zod` (short alias `spnpm add zod`) is the
same keystrokes as `pnpm add zod`: it vets with the gate engine, then installs mode-aware (native on a
host-native or fresh project, contained when the tree already is). Binaries: `sandbox-npm`/`snpm`,
`sandbox-pnpm`/`spnpm`, `sandbox-yarn`/`syarn`, `sandbox-bun`/`sbun`, `sandbox-npx`/`snpx`,
`sandbox-bunx`/`sbunx`. The explicit `sandbox <pm> …` form always containerizes and names the package
manager when you don't want to rely on detection.

- Mode-aware, not always containerized: a fresh or host-native project installs natively; a tree that
  is already a container build keeps getting contained installs (no host creds, default-deny egress,
  `--cap-drop ALL`). For the always-container boundary, use explicit `sandbox <pm>`.
- The real `npm`/`pnpm` is never shadowed; the user opts in by typing the prefix.
- One mode per project: a contained install (explicit `sandbox <pm>`, or a per-PM binary on an
  already-container tree) builds a container `node_modules` (Linux tree); a native install or the
  user's own `pnpm install` keeps it host-native. Never both. sandbox tells them apart by the native
  binaries in the tree, read live (so the signal can't go stale after a host install). Before
  clobbering a host-native tree, sandbox warns (TTY: confirm the switch; CI / non-TTY: logs and
  proceeds). For host tooling against a container tree, run it through `sandbox`, or use `sandbox
  devcontainer init` to keep `node_modules` in a Docker volume.
- CI enforcement: `sandbox verify` + `--frozen --fail-on-egress`; agents: the `--agent` hook or
  `sandbox devcontainer init`.

## `approve-builds` command (resolve pnpm dependency build scripts)

When pnpm blocks dependency build scripts it records placeholder values in `allowBuilds:` inside
`pnpm-workspace.yaml` and exits. `sandbox` lets you record the decision without hand-editing YAML:

- `sandbox approve-builds`: approve every pending package and re-run the install flow
- `sandbox approve-builds esbuild sharp`: record decisions for specific packages
- `sandbox approve-builds --deny sharp`: record `false` and remove `sharp` from `onlyBuiltDependencies`
- `sandbox --allow-all-builds pnpm install`: approve every pending build script without prompting

On a TTY, `sandbox pnpm install`, `sandbox pnpm up`, and `sandbox pnpm audit --fix` prompt
automatically, write `allowBuilds` plus `onlyBuiltDependencies`, then retry the command.

## Flags this skill uses

| Flag | Effect |
|---|---|
| `--fail-on-risk` | Exit 1 when any risk hint is found (blocks before running). |
| `--fail-on-advisory` | Exit 1 when a version is flagged as malware in OSV. |
| `--allow-deprecated` | Allow a maintainer-deprecated version (deprecated **blocks by default**). |
| `--min-release-age <days>` | Block versions younger than `<days>`. `0` disables. Strict preset = 7. |
| `--allow-recent <pat>` | Exempt a package-name pattern from the age gate (repeatable; globs ok, e.g. `@scope/*`). |
| `--deep` | Apply the age gate to the whole resolved tree (lockfile), not just direct deps. |
| `--risk <off\|basic>` | Disable/enable registry risk hints. |
| `--allow-all-builds` | Approve every pending pnpm dependency build script without prompting, then re-run the install-class command. Use only when the user has already approved that blanket choice. |
| `--allow-build-hosts` | Add the curated native-build/release hosts (Node headers, GitHub releases, Prisma/Playwright/Cypress/Puppeteer/Electron binaries) to the egress allowlist for this run. **Still default-deny** (a bigger allowlist, not full network). Use when a `postinstall` binary download is blocked; prefer `sandbox allow <host>` when only one host is needed. |
| `--canaries` / `--no-canaries` | Plant fake AWS/Stripe/Slack honeytokens in the install container and fail the run if one reaches the egress proxy log (a credential-theft tripwire on top of default-deny egress). Allowlist egress only; **on by default in the `strict`/`agent` presets**. Names no package manager reads, so it can't break an install; `--no-canaries` turns it off for one run. Applies to the real install, not the `preflight` review pass. |
| `--dry-run` | Preview mounts/allowlist/command, then stop. On `install`/`add`/`run` this **skips the preflight**; use the `preflight` command for the review pass instead. |
| `--json` | On `preflight`, prints the findings report (above). On `install`/`add`/`run`, prints the resolved plan and skips the preflight. |

Strict review pass = `sandbox --fail-on-risk --fail-on-advisory --min-release-age 7 preflight <pm> install`.

## Reading findings

Default: human lines on **stderr**. Set `SANDBOX_LOG=json` for NDJSON events
(`{"level":"error","msg":"...","...":...}`); `SANDBOX_LOG_LEVEL=debug|info|warn|error` filters.

Output shapes to recognize:

- **Release-age block:** `blocked by the release-age gate (min 7 days)` followed by
  `<name>@<version> was published <N hours/days> ago`.
- **Malware:** `<name>@<version> KNOWN MALWARE advisory (MAL-…)` then
  `blocking: a version is flagged as malware and --fail-on-advisory is set`.
- **Advisory (non-malware):** `<name>@<version> advisory <ids>`.
- **Risk hints:** `N thing(s) worth a look before installing`, worst-first (✖ error blocks
  ahead of ⚠ warnings), then per-package lines. `N` counts real signals only: a `bin_exposed`
  (`adds bin: <name>`) never counts and a package whose *only* signal is a bin stays silent
  (it's still in `--json`); the bin line shows only next to another finding. A `recent_version`
  message (`!!` marks strong severity) may carry an aged-version line:
  `↳ <older> predates the worm window (published <N> ago): sandbox <pm> add <pkg>@<older>`, a
  copy-pasteable older release, framed as age, not safety.

## Override recipes

- Approve one fresh package, keep the gate otherwise:
  `sandbox --allow-recent <pkg> --fail-on-advisory install`
- Accept all fresh releases this once: add `--min-release-age 0`.
- Pin a known-good older version instead of latest: `sandbox add <pkg>@<version>`.
- Native module's `postinstall` blocked on a build host (node-gyp/Prisma/Playwright/…):
  re-run with `--allow-build-hosts` (curated bundle, still default-deny), or allow the exact
  host: `sandbox allow <host>`. Persist for the project via the `build-tools` group in
  `sandbox init`, or by adding the host to `egress.allow`.
- Persist a tolerance in `sandbox.config.json`: `install.minReleaseAgeExclude`,
  `install.minReleaseAgeDays`, `install.failOnAdvisory`, `install.failOnRisk`.

## Containment note

Even on "proceed," the install runs jailed: persistence paths (`.git`, `.github`, `.husky`,
`.claude`, …) and `package.json` are read-only, no host creds are mounted, and egress is
default-deny (registry-only allowlist). Under the `strict`/`agent` presets, canary honeytokens
also ride along, so an exfiltration attempt is caught in the act. The prompt is a "spend the
risk?" decision; containment is the backstop.
