# @jagreehal/sandbox-node

## 2.0.0

### Major Changes

- 9cb0849: Make screen-node genuinely container-free. The inherited Docker/container subsystem (image build, egress proxy, network firewall, devcontainer, demo, agent PreToolUse hook) has been removed. Every install/add/update/remove now runs the supply-chain gate engine first, then installs natively on the host. Removed the `build`, `demo`, `devcontainer`, and `shell` commands and the `--backend`/`--image` container config fields; `run`/`x`/`audit` now pass through natively.
- 4dd2b95: Finish the screen rebrand: rename the remaining internal env vars to the
  `SCREEN_*` prefix (`SCREEN_LOG`, `SCREEN_PM_BIN`, `SCREEN_NPM_REGISTRY`, etc.)
  and on-disk names to `screen.advisories.json`, `.screen-audit-ignore`, the
  `.screen` agent dir, and the `screen-node` XDG dir. The integration golden tests
  were updated to the container-free, `screen`-branded surface (removed-feature
  tests deleted) and now pass.
- 86c2954: Rebrand the CLI surface from `sandbox` to `screen`: the command is `screen` (with
  the `s<pm>` aliases), log output is `screen:`-prefixed, the off switch is
  `SCREEN_OFF`, and the config/schema files are `screen.config.json` /
  `screen.schema.json`. Honest threat model in SECURITY.md; AGENTS.md reorients the
  repo. Stale sandbox-node reference docs and skills removed.

## 3.0.0

### Major Changes

- 9bf29c6: Mode-aware install: install in the project's one mode (native by default, contained when the tree
  already is).

  `sandbox install` / `sandbox add <pkg>` / `sandbox update` (and the per-PM binaries `spnpm`, `snpm`,
  `syarn`, `sbun`) vet, then install **mode-aware**:

  - a host-native or fresh project (no `node_modules`, or no native-platform signal) installs
    **natively on the host**, so your IDE and tools load the result.
  - a project whose `node_modules` is a container (Linux) build installs **contained**.

  The explicit `sandbox <pm>` form (`sandbox pnpm add zod`) always containerizes: the force-container
  boundary on demand. `sandbox check` vets without a container.

  Each write prints one action line, native
  (`installing natively on the host with pnpm (host-native deps; gates ran, no container boundary)`) or
  contained
  (`installing in a throwaway container with pnpm (container-built deps; no host creds, default-deny egress)`),
  and names its operation (`removing …`, `adding …`). A native install runs lifecycle scripts on the
  host, so the gates are heuristics, not a boundary; the container is the boundary. Native honours
  `--frozen` and the gate engine's safe-install pins, like the contained path.

  pnpm build-script approval (`--allow-all-builds`, the interactive prompt, `sandbox approve-builds`)
  applies on both the native and contained paths, keyed off the package manager in the command (so
  `sandbox npm install` in a pnpm repo skips pnpm build-approval). `sandbox approve-builds` and
  `sandbox upgrade --write` install through the same mode-aware path.

  BREAKING: on a fresh or host-native project the friendly verbs and per-PM binaries install natively
  (gates only, no container boundary). Use `sandbox <pm>` or `sandbox devcontainer init` for the
  container boundary.

### Patch Changes

- 9bf29c6: Update the docs site homepage and command docs to match the current native-default, mode-aware install model. The site now explains that `sandbox add` vets first, installs natively on fresh or host-native projects, keeps container-built trees contained, and reserves explicit `sandbox <pm>` for the throwaway-container boundary.

## 2.0.0

### Major Changes

- 17095c0: Vetted-and-contained by default, with a clearer write path and a happy IDE.

  ## One mode per project (the model)

  `node_modules` is in exactly one mode at a time: local (a host-native tree from your own package manager) or container (a Linux tree built by a contained install), never both and never auto-reconciled. See `docs/rfc-native-default.md` for the full model.

  **The default write path is `sandbox install`, `sandbox add <pkg>`, `sandbox update`.** Sandbox auto-detects your package manager (npm/pnpm/yarn/bun) and mirrors the verb, vets the target versions before any byte is fetched, then runs the install in a throwaway container with no host credentials, default-deny egress, lifecycle scripts contained, and `--cap-drop ALL`. To review a package without installing, `sandbox check <pkg>` (no Docker).

  Before every contained write, sandbox prints one orienting line, `pnpm · container-built deps · contained` (package manager, project mode, containment), so you always know which tree you are touching. It stays one line; findings stay loud.

  **Expert: per-PM binaries.** `sandbox-npm`/`sandbox-pnpm`/`sandbox-yarn`/`sandbox-bun`/`sandbox-npx`/`sandbox-bunx` and the terse aliases `snpm`/`spnpm`/`syarn`/`sbun`/`snpx`/`sbunx` are muscle-memory shortcuts for the same contained path. `spnpm add zod` is exactly `sandbox pnpm add zod`. They never shadow your real package manager; you opt in by typing the prefix. pnpm/yarn run through Corepack, so a host with Node but no global PM shim still works.

  **BREAKING: `--sandbox`, the native-install path, and `sandbox materialize` are removed.** The previous direction (`sandbox-<pm>` installs natively on the host by default, `--sandbox` to contain, `sandbox materialize` to rebuild a host tree) is gone: it made the gates a boundary only on opt-in, and `materialize` was a fragile reconciliation step. The default path is now contained, so the "gates are heuristics, not a boundary" caveat no longer applies. For a host-native tree your IDE loads, run your own package manager (`pnpm install`); for containment and a happy IDE together, use `sandbox devcontainer init`.

  **BREAKING: `sandbox path install` is removed.** The shell-function takeover that shadowed bare `npm`/`pnpm`/`yarn`/`bun` is gone. Use the `sandbox-<pm>` / `s<pm>` binaries, which come on PATH with the install and never shadow the real tool. If you previously ran `sandbox path install`, delete the `# >>> sandbox path` block from your shell rc by hand.

  **Cross-mode safety.** Before a contained install rebuilds `node_modules`, if the existing tree looks host-native sandbox warns and, on a TTY, asks you to confirm the switch, so a Linux tree your IDE can't load never silently replaces a working local one. The signal is read live from the tree, not a written marker, so it can't go stale after a later host install.

  **`sandbox devcontainer init`** mounts `node_modules` as a named Docker volume (not part of the bind-mounted source) and installs into it on container create: the path that keeps the full container boundary AND a happy IDE. When the egress firewall is on, it is applied before the create-time install so that install is itself contained.

  ## Safe install by default

  `sandbox add <pkg>` does the safe thing and gets out of your way: when the version it would install is freshly published (inside the supply-chain worm window) and an older release already predates the window, sandbox installs that older release and pins it exact in the right manifest, then prints what it did and how to override (`--allow-recent <pkg>`, or `install.safeInstall: false`). The scope is freshness only: malware, typosquats, and CVE advisories are handled upstream by the gate engine, not by this swap. New config: `install.safeInstall` (default `true`) and `install.pinExact` (default `false`). A substituted version is always pinned exact.

  ## Source-write tripwire

  The source tree stays writable during an install by design (a package manager needs a writable root), the one surface NOT protected by default. That residual is now visible: an install that changes project files outside dependency output is recorded in the audit log (`SANDBOX_AUDIT_LOG`) as an `install.source-write` event, alongside `egress.denied` / `canary.exfil`. `--fail-on-source-writes` (config `install.failOnSourceWrites`, default `false`; on by default in the `strict` preset) fails an otherwise-clean install that touched your source tree, so CI or an agent notices and reverts. This is detection after the fact, not prevention: review with `git diff`, revert with `git checkout`.

  ## Sharper risk-hint output

  - **Worst-first ordering.** Findings lead with the error-level packages (typosquat, dropped provenance, malware-window publishes) above the warnings, so the most serious finding can't land buried mid-list.
  - **Bins stop being noise.** A package adding a command-line binary is the boundary doing its job, so it no longer counts toward "N things worth a look" and a package whose only signal is a bin stays silent. The bin still shows as a sub-line next to a real finding, and every hint remains in `--json`.
  - **Freshness hints offer an older release.** A freshly-published version points at the newest release that predates the worm window, with a copy-pasteable pin, framed as age, never as safety.

## 1.7.1

### Patch Changes

- c242a1a: Better dx

## 1.7.0

### Minor Changes

- cbd088d: DX pass: complete the package-manager verb surface, add `sandbox check`, and an `off` escape hatch.

  **Contained dependency removal — the missing peer of `add`.** `npm uninstall` / `pnpm remove` /
  `yarn remove` / `bun rm` (and aliases `rm`/`un`) now route through the sandbox as a deliberate,
  write-class manifest change, so the removed package's `preuninstall`/`postuninstall` scripts run in
  the throwaway box instead of against your real home dir. Removal fetches nothing new, so there's no
  supply-chain surface to gate. Previously these fell through to the generic `run` model and, once
  `sandbox path install` was active, bare `npm uninstall` ran on the host while `npm install` was
  sandboxed. The drop-a-dep verbs are now mirrored across the router, the shell wrappers, the agent
  `PreToolUse` hook, and tab-completion, with a new explicit `sandbox remove <pkg...>` command.

  Two more completeness wins:

  - **`sandbox x <tool>`** — an `npx`/`bunx` muscle-memory shorthand (`sandbox x vite`), PM-aware (bun
    projects get `bunx`) and local-first.
  - **`dedupe` is now contained correctly** — `npm/pnpm/yarn dedupe` (and `npm ddp`) re-resolve against
    the registry, so they run install-class with registry egress instead of falling through to a
    no-network `run` that couldn't re-resolve.

  **`sandbox check` — audit packages before you install them.** A read-only review pass with **no
  container and no Docker**: it only queries the registry and the OSV advisory DB.

  - `sandbox check express lodash@4` — bare names, the friendly common case.
  - `sandbox check` — the whole project: the root manifest **and every workspace `package.json`** in a
    monorepo, deduped (local `workspace:`/`file:` deps are skipped).
  - `sandbox check ./apps/web/package.json` — the deps in a specific manifest; a `package.json` is read
    workspace-aware, and relative paths resolve from your current directory.
  - `sandbox check npm install x` — a full command form.

  It always queries OSV, so a bare `check` actually checks. Blocks on malware/known-bad; the usual
  flags (`--min-release-age`, `--fail-on-advisory`, `--fail-on-risk`) tighten it for CI. `preflight` is
  the command-mirroring sibling (and now also always queries OSV).

  **Turn containment off for a trusted repo.** A new top-level `off` config field (default `false`):
  when set, every operation command runs straight on the host, exactly as if `sandbox` weren't in front
  of it. Set it for the whole team in `sandbox.config.json`, or just for yourself in
  `sandbox.config.local.json`, so a globally-wired `sandbox path install` stops sandboxing there. The
  env var `SANDBOX_OFF=1` now does the same for the CLI itself (previously only the shell wrappers
  honored it), and **`sandbox off` / `sandbox on`** toggle the local override in one keystroke.
  Sandbox-only commands (`check`, `doctor`, `init`, `verify`, …) keep working regardless. As a
  first-class security control, `off` rides the existing guardrails: enabling it from a personal layer
  fires the loudest "loosen loudly" warning, and `sandbox off` ensures the local override is git-ignored
  so a containment disable can't be committed for the whole team.

  **Polish.** `sandbox doctor` now prints a one-line verdict (an all-clear run names the next two
  commands; a failing run counts what needs attention), and the README is trimmed to a tight intro with
  the full reference moved to `docs/reference.md`.

## 1.6.0

### Minor Changes

- c410733: Cut typosquat false positives and sharpen install-review DX.

  - **Typosquat**: skip names shorter than 5 characters (where a 1–2 edit band matches half the registry — `ai`, `vm`, `js`, `mcp`) and skip members of a reputable scope that owns a package in the top-packages corpus (`@typescript-eslint/parser`, `@ai-sdk/mcp`, `@total-typescript/ts-reset`). A real impersonation of a popular long name still flags.
  - **preflight**: a bare reproduce-the-lockfile install that blocks on release-age now points to `sandbox delta`, the low-noise gate that judges only what a change introduces rather than every already-committed dependency.
  - **doctor**: surfaces a `node_modules` platform-mismatch check, so a container-built tree (e.g. `@rolldown/binding-linux-*`) is explained before host tooling fails with a cryptic missing-binding error. Exit code is now a single derived rule — `info`-level notes (like a missing config file) never fail the run.

## 1.5.1

### Patch Changes

- 9cb5f65: Dev-server port output: readable, honest, no `[object Object]`

  The 1.5.0 "ports forwarded" line attached the endpoints as a structured field, which the
  human logger rendered as `(endpoints=[object Object],[object Object],…)`. Beyond the broken
  rendering, listing five "open me" URLs for the dev-port catch-all is misleading — only one of
  them actually serves.

  - **Logger**: object-valued fields serialize as JSON instead of `[object Object]` (a logger
    should never emit that for a structured value).
  - **One port** (explicit `run.ports`): print the exact clickable URL — `port forwarded →
http://localhost:4321`.
  - **Many ports** (the dev catch-all): name the mapped ports and point at the URL the dev server
    prints itself, rather than five URLs where four have nothing behind them.
  - **Skipped / duplicate ports**: concise one-liners, no redundant `(skipped=…)` echo.

## 1.5.0

### Minor Changes

- 89dac48: Dev-server DX: deterministic, conflict-safe port publishing

  - **Truthful URLs.** Ports now publish as explicit `HOST:CONTAINER`, so the forwarded URL the CLI
    prints is the real host port. A bare `run.ports` entry like `"4321"` no longer maps to a random
    Docker-assigned host port.
  - **Port conflicts no longer abort the run.** Host ports already in use (e.g. `8080`) are probed
    and skipped with a one-line notice instead of failing the whole run with a Docker bind error;
    the remaining dev ports still map. The run log also emits structured `endpoints` (`{ container,
host, url }`) for machine-readable / agent consumption.
  - **`run.ports` accepts numbers and honours a bind IP.** `4321` and `"4321"` are both valid
    (alongside `"3000:3000"` and `"127.0.0.1:3000:3000"`); a malformed value now reports the accepted
    forms instead of a terse "expected string, received number". An `IP:HOST:CONTAINER` spec publishes
    on that interface, prints the IP in its URL, and counts as distinct from the same port on another
    IP. A second spec claiming an already-claimed host endpoint is surfaced as an ignored duplicate
    rather than dropped silently.
  - **`sandbox init` no longer dead-ends without a TTY.** With no TTY and no `--preset`, it writes
    the safe `balanced` preset and says so, rather than erroring.
  - **Bind mounts use `docker --mount` instead of `-v`.** The `key=value` form never splits on `:`,
    so a Windows host path like `C:\Users\you\proj` mounts correctly. Mounts that relied on `-v`'s
    implicit directory creation (the project Claude config dir) keep that behaviour via an explicit
    pre-run `mkdir`.
  - Devcontainer base image bumped to Node 24 (`javascript-node:24-bookworm`) to match the bundled
    sandbox image and the current LTS line.

## 1.4.1

### Patch Changes

- e3d0d67: Don't sandbox global installs — they're host tooling (all package managers).

  `npm install -g <pkg>` (and `pnpm add -g`, `bun add -g`, `--global`, `--location=global`, plus
  yarn classic's `yarn global add`) routed through the path wrappers ran inside the ephemeral
  container, so nothing landed on the host — a silent no-op that looked like a successful global install.

  - The path wrappers (zsh/bash/fish/pwsh) now pass any global install straight through to the real
    package manager. `PATH_WRAPPER_VERSION` is bumped so `sandbox path status` flags existing blocks
    as outdated — re-run `sandbox path install` to update.
  - As defense in depth, `sandbox <pm> … -g` (or `yarn global add …`) invoked directly now refuses with
    guidance (`command npm install -g …`) instead of doing a useless in-container install. Detection
    covers the flag form (npm/pnpm/bun) and yarn classic's `global` subcommand.

- e3d0d67: Add a version command/flag: `sandbox version`, `sandbox -v`, and `sandbox --version` print the
  installed sandbox version (previously `--version` errored with "unknown command").

## 1.4.0

### Minor Changes

- 612ad8c: Sandbox install reliability, image caching, and build-script approval.

  **Per-fingerprint image tags** — Tag the managed sandbox image per build fingerprint instead of one shared `:latest`. Every project previously shared the `node-install-sandbox:latest` tag, even though its contents depend on per-project config (notably the baked `packageManager` version). Switching between projects with different package managers rebuilt and re-tagged that one image back and forth — which also flipped the baked pnpm version, made a project's `node_modules` look foreign, and triggered a (no-TTY-fatal) reinstall purge. The managed image now resolves to `node-install-sandbox:<fingerprint>`, so projects with different build configs each keep their own cached image — no cross-project clobbering, stable reuse, and no spurious purges. Custom/explicit `config.image` values are still used verbatim.

  **Build approval** — Resolve pnpm's ignored dependency build scripts without hand-editing YAML. When pnpm refuses an unknown install script it records the package under `allowBuilds:` in `pnpm-workspace.yaml` as undecided and exits non-zero — previously you had to hand-edit two config blocks to continue. Now a sandboxed install detects the pending decision and:

  - **prompts on a TTY** (multiselect, all selected by default), writes the decision to both `allowBuilds` and `onlyBuiltDependencies`, and re-runs the install so the scripts build;
  - **prints a ready-to-run `sandbox approve-builds <pkg…>`** line and keeps the safe non-zero exit when there's no TTY (CI/agents);
  - **approves everything with `--allow-all-builds`** for non-interactive runs.

  Adds the `sandbox approve-builds [pkg…]` command (`--deny` records the opposite decision) and the `--allow-all-builds` flag. Build approval is currently pnpm-only.

  **No-TTY install fix** — Fix installs aborting (and never writing a lockfile) in the no-TTY container. The container env hard-set `CI=''`, so pnpm assumed it could prompt and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` whenever it needed to purge `node_modules` (common after the baked package-manager version changed) — leaving the install failed and the lockfile unwritten. Install-class plans (`install`/`add`/`update`/`audit fix`) now run with `CI=1`, which is correct for a non-interactive container. Interactive `run`/`dev` plans keep `CI=''` so a real TTY can still drive prompts.

  **Quieter install output** —

  - `pnpm-workspace.yaml` edits are now treated as expected install writes. pnpm legitimately records build-script approvals (`allowBuilds`) and release-age exclusions there during an install, so the "changed N project file(s) outside dependency output paths" warning no longer fires on its own benign edits (which trained people to ignore the warning that matters).
  - The host-incompatible-native-packages notice is now a single calm `info` line with the fix inline, instead of a `warn` + `info` pair that repeated on every install.

## 1.3.0

### Minor Changes

- 575d434: Enriched advisory scan with severity, triage, fix hints, and agent output

  **Richer OSV data.** Advisory lookups now parse CVSS severity, summaries, and fixed
  versions from OSV. `sandbox scan` groups hits by severity (critical/high/moderate/low),
  labels each package as direct or transitive, and prints actionable fix lines — `sandbox
<pm> update` for direct deps, `overrides`/`resolutions`/`pnpm.overrides` for transitive
  ones.

  **Advisory triage.** Add a `.sandbox-audit-ignore` file to suppress accepted findings:
  `<package> [<advisory-id>] [-- <reason>]` per line. Triaged hits are reported separately
  and excluded from severity counts and blocking logic.

  **Agent-friendly scan output.** `--format agent` (alias `--format ai`) emits a compact,
  line-oriented report for automation — severity totals, per-package advisories, and fix
  hints without JSON scaffolding.

  **Package manager detection.** `packageManager` resolution also reads the `devEngines`
  field when the standard `packageManager` key is absent.

## 1.2.0

### Minor Changes

- 69df2d3: Warn when a contained install leaves host-incompatible native dependencies

  Installs run inside the Linux sandbox, so package managers fetch the Linux build
  of platform-specific native optional deps (`@rollup/rollup-linux-*`,
  `@esbuild/linux-*`, `@img/sharp-linux-*`, …). On a macOS or Windows host those
  binaries can't load, and host-side tools (`vite`, `vitest`, `tsx`) fail with a
  cryptic _Cannot find module `@rollup/rollup-darwin-arm64`_.

  After an install, `sandbox` now scans `node_modules` for packages whose declared
  `os`/`cpu` excludes the host and warns with the offending package names, pointing
  at the fix (run tools through `sandbox`, or do a plain host install for native
  host-side dev). The check is host-relative and self-gating — it stays silent when
  the install platform matches the host (e.g. a Linux host) — and only inspects
  packages whose name carries a platform token, so it adds no measurable cost.

## 1.1.1

### Patch Changes

- c0dd887: Tightens CLI behavior and project guardrails.

  **Safer one-off networking semantics.** `--full-network` now widens install/run networking without
  implicitly turning on dev-port publishing for non-dev commands. Port forwarding stays tied to dev-mode
  runs instead of being enabled as a side effect of broader network access.

  **Machine-readable build output.** `sandbox build --json` now emits the resolved build spec so
  automation can inspect the image build plan without scraping human-oriented logs.

  **Maintainer guardrails.** The repo test path now includes import-cycle detection, committed pnpm
  policy verification, and release-metadata checks, with integration coverage for those checks.

## 1.1.0

### Minor Changes

- eaac81f: Native package scripts, monorepo task runners, smarter egress defaults, and an update notice.

  **Run package.json scripts natively.** `sandbox dev`, `sandbox test`, `sandbox <script>` route any
  script through your package manager's native syntax (auto-detected from `package.json#packageManager`
  then the lockfile). `sandbox dev` runs the first of `dev`/`start`/`serve` with dev-mode networking.
  Built-in commands win on a name clash; force a colliding script with `sandbox script <name>`. The
  monorepo task runners route directly too: `sandbox turbo …` and `sandbox nx …`.

  **Smarter, still-minimal egress.** Detection prefers the `packageManager` field (Corepack semantics)
  over the lockfile. The effective allowlist is package-manager aware — yarn classic adds its own
  registry (`yarnpkg.com`) so a `yarn install` works out of the box, while the committed config stays
  minimal. New `--allow-build-hosts` opts into the curated native-build/release hosts (node-gyp,
  Prisma, Playwright, Cypress, Puppeteer, Electron, GitHub releases) for one run — still a default-deny
  allowlist, not full network. `sandbox init` can pre-allow opt-in egress bundles (host groups):
  `build-tools` plus narrow cloud groups (`vercel`/`cloudflare`/`supabase`/`aws`), scoped to specific
  control-plane hosts only — never provider-wide wildcards, and `aws` is STS-auth-only.

  **Update notice.** On an interactive run, `sandbox` prints a "new version available" notice (to
  stderr, from a once-a-day cached background check). Off automatically for `--json`/non-TTY/CI; disable
  with `--no-update-check`, `NO_UPDATE_NOTIFIER`, or `updateCheck: false`. No new dependencies.

## 1.0.0

### Major Changes

- ad17287: Add `runCode(code, options)` — a programmatic API for executing untrusted / AI-generated JavaScript or TypeScript inside the sandbox and getting its captured output back. Unlike `vm.runInThisContext` or in-process "sandbox" packages (which Node's own docs warn are not security boundaries), code runs in a throwaway container with no host credentials and no network by default, and a real wall-clock timeout is enforced by a separate process (the container's init), so a busy loop can't block or outrun it the way it defeats an in-process `vm` timeout. Returns `{ stdout, stderr, exitCode, timedOut, durationMs, deniedHosts }`. TypeScript runs via Node's built-in type stripping (no `tsx`, no network). Supports `network: 'allowlist'` egress, extra `files`, and `env`.

  Internally this adds output capture to the canonical run layer: `execute(plan, backend, { capture: true })` now returns `stdout`/`stderr` in its `ExecuteResult`.

  **BREAKING:** the `ContainerBackend` interface gained a required `runPlanCaptured(plan, override?)` method. Anyone who implements `ContainerBackend` themselves (rather than using `createBackend`) must add it — it runs the plan capturing stdout/stderr, the sibling of `runPlan` which inherits stdio. Consumers using `createBackend('docker' | 'podman')` are unaffected.

## 0.6.2

### Patch Changes

- 4b6496b: Don't flag nested workspace `node_modules` as tampering.

  The post-install integrity check skipped only the root `node_modules/`, so a
  workspace/monorepo install — which writes into per-package `node_modules`
  (`app/node_modules`, `packages/*/node_modules`, …) — was reported as "changed N project
  file(s) outside dependency output paths". `node_modules` at any depth is now skipped, while
  paths that merely mention it (e.g. `src/node_modules_loader.ts`) are still checked.

## 0.6.1

### Patch Changes

- 4f74b23: Stop flagging pnpm's project-local store as tampering.

  pnpm relocates its content store next to `node_modules` (`.pnpm-store/`) when its
  configured store is on a different device than the project — always the case for a
  bind-mounted workspace. An install legitimately writes thousands of files there, which the
  post-install check reported as "changed N project file(s) outside dependency output paths".

  `.pnpm-store/` is now treated as an expected install artifact. When pnpm creates one, the
  run prints a short note that `node_modules` is tied to that in-project store, so running
  pnpm directly on the host rebuilds it against the host store — run later commands through
  `sandbox` to reuse it as-is. Adds `wroteProjectLocalPnpmStore`.

## 0.6.0

### Minor Changes

- cf39ae9: Bake the project's pinned package manager into the image at build time.

  The bundled image pre-activates pnpm 9.15.0 / yarn 1.22.22. A project that pins a
  different version via package.json `packageManager` (e.g. `pnpm@11.5.3`) previously made
  corepack try to download that version at run time, which fails behind the egress proxy
  (corepack doesn't route through it) and in no-network phases — so `sandbox pnpm install`
  broke for most modern pnpm/yarn repos.

  `resolveBuildSpec` now reads the project's `packageManager` field and, when it differs from
  the baked version, prepends a `corepack prepare <pinned> --activate` step (run during the
  build, where the network is available; the integrity hash is passed through so corepack
  verifies it). npm/bun and already-baked versions add no step.

  New exports: `parsePackageManagerField` (package-manager), `corepackPrepareStep` and
  `BAKED_COREPACK` (image).

## 0.5.1

### Patch Changes

- 06c0524: Add several security-focused checks and evidence tools around the sandbox boundary.

  - Add `sandbox secrets` for offline committed-secret scanning, and allow `sandbox verify --secrets`
    to fail the boundary gate when credentials are found.
  - Add local known-bad package blocking via `sandbox.advisories.json` and cached malware feeds
    managed by `sandbox feeds <update|list>`, and apply those checks to preflight, scan, delta, and
    upgrade flows.
  - Add canary honeytokens for allowlisted installs, plus `sandbox demo` to run real containment
    scenarios against the live sandbox.
  - Add signed verify receipts, key generation, and audit-log verification with
    `sandbox verify --sign`, `sandbox verify-receipt`, `sandbox keygen`, and
    `sandbox audit verify`.
  - Expand `sandbox doctor` to flag known runtime container-escape issues and end-of-life Node
    versions in the sandbox image.

## 0.5.0

### Minor Changes

- ba226f7: New `sandbox upgrade` command, shell-wrapper wiring, and onboarding polish.

  **`sandbox upgrade`** — config-driven safe dependency upgrades. Wraps `ncu` to bump dependencies only within ranges you opt into, so routine updates stay inside the sandbox boundary. Honors per-package cooldown exemptions and writes exactly what was gated, so you can see why an upgrade was held back.

  **Shell wrappers** — `sandbox setup` now offers to wire shell wrappers so a bare `npm install` routes through the sandbox automatically. No need to remember the `sandbox` prefix; opt in during setup.

  **Onboarding & docs** — clearer onboarding tips, more honest build messaging, and hot-reload docs that describe what actually works rather than overselling it.

## 0.4.0

### Minor Changes

- e40fe9f: Supply-chain lifecycle gating, packaging fix, and CLI polish.

  **Fix:** ship `net-guard.sh` in the npm package. The published Dockerfile does `COPY net-guard.sh`, but the file was missing from `files`, so a fresh `sandbox npm install` failed at image build with `"/net-guard.sh": not found`. Added a `test/packaging.test.ts` regression guard that asserts every Dockerfile `COPY` source is published.

  **`sandbox scan`** — retroactive malware sweep. Re-queries OSV for the versions in the committed lockfile and exits non-zero if any installed package is now flagged as malware (`MAL-…`). Closes the time gap install-time gating can't cover. No container needed; cheap to run nightly in CI. `sandbox verify --scan` folds it into the boundary gate.

  **`sandbox delta [--base <ref>]`** — gate only what a PR changes. Diffs the lockfile against the merge target (default `origin/main`, or `--base-lockfile <path>`) and runs the release-age, malware, and deprecation gates over just the added/bumped versions. Fails safe (gates everything) if the base lockfile can't be read.

  **`sandbox completion <shell>`** — tab-completion scripts for zsh, bash, and fish (commands, globals, and `--preset` / `--backend` / `--risk`).

  **First-run build feedback** — clear progress during the one-time image build (clack spinner on a TTY, plain stderr lines in CI). Distinguishes absent vs stale images when config changed since the last build.

  **`sandbox doctor` improvements** — reports whether the image is absent, current, or stale (out of date vs config); optional `--fix` auto-rebuilds a missing or stale image.

  Both scan/delta reuse the existing OSV/registry engine, honor `--min-release-age` / `--fail-on-advisory` / `--json`, and expose `parseLockfilePackages` for parsing a lockfile from text (e.g. a git blob).

## 0.3.0

### Minor Changes

- ea5e1cb: Add guided egress remediation, a warm package-manager cache, native-module onboarding, host classification, and `sandbox path` shell wrappers.

  - **Guided egress (`--interactive`)**: when default-deny blocks a host, prompt (TTY-only) to allow once, save for the team (`sandbox.config.json`), save for yourself (`sandbox.config.local.json`), or retry once with full network — with each blocked host annotated (registry / native-build / unknown).
  - **Warm cache (`install.cache`, on by default)**: persist each package manager's content-addressed download store in a named volume across runs; also applied to the fetch-and-run runners (`npx`/`bunx`/`pnpx`/`<pm> dlx`). Set `install.cache: false` for a cold, per-run-isolated install.
  - **Native-module onboarding**: `sandbox init`/`setup` now pre-allow `nodejs.org` when the project has node-gyp/prebuild indicators, so the common first-run native build doesn't fail on egress.
  - **`sandbox path [install|uninstall|status|print]`**: install shell wrappers (zsh/bash/fish/pwsh) so a bare `npm/pnpm/yarn/bun install` and the fetch-and-run commands (`npx`, `bunx`, `pnpx`, `<pm> dlx`, `<pm> exec`) route through `sandbox` automatically — the human equivalent of the agent hook. Bypass with `command npm …` or `SANDBOX_OFF=1`.
  - **Host classification** exported from the library (`classifyHost`, `describeBlockedHosts`) for reuse.
  - **Fix**: `sandbox allow` (and the team-save path) now write only the committed project layer, so a personal `*.local.json` / user-global override can no longer be baked into the shared config.
