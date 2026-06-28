# AGENTS.md: agent orientation for the sandbox-node repo

Entry point for AI coding agents working in this repository. Follows the [`AGENTS.md` convention](https://agents.md); [`CLAUDE.md`](CLAUDE.md) is a symlink to this file, so Claude Code and the convention read identical content.

## Read this first

- This file: orientation, the product's one job, the output voice, how to build/test, code conventions, repo layout, releasing.
- [`docs/rfc-native-default.md`](docs/rfc-native-default.md): the accepted pivot that defines the current product story (gate-first, native-default, container on demand). Read it before touching install routing, the `sandbox-<pm>` binaries, or the thesis docs.
- [`README.md`](README.md): what the tool is and the user-facing surface.
- [`docs/reference.md`](docs/reference.md): the full command and config reference.
- [`sandbox.schema.json`](sandbox.schema.json): the config manifest schema. **Generated** by `pnpm gen:schema` from `src/config.ts`; never hand-edit it.
- [`SECURITY.md`](SECURITY.md): the threat model and what is / isn't protected. Read before touching anything in `proxy/`, `net-guard.sh`, or the mount/egress logic.

## The one job: keep it in view

sandbox-node **catches a bad dependency before it lands** and **contains it on demand**. The everyday product is the **gate engine**: before an install fetches anything, it checks the target versions against OSV malware advisories, your malware feeds + team advisories (hard block), typosquats, the release-age worm window (with safe-install substitution), and deprecation. Then it installs **mode-aware**: a host-native or fresh project installs **natively on the host** (so your IDE and tools get host-native binaries and just work), while a project whose `node_modules` is already a container (Linux) build keeps getting contained installs. **The gate engine is the product.** When you don't trust the code, one opt-in (the explicit `sandbox <pm>` form, or `sandbox devcontainer init`) runs the whole thing in a throwaway Docker/Podman container: no host credentials, default-deny egress, `--cap-drop ALL`. The container is the strongest protection, but it's the **on-demand boundary**, not the everyday path.

The honest line, hold it everywhere: native install runs lifecycle scripts on the host, so the gates are **heuristics, not a boundary**. The container is the boundary; reach for it when trust drops. The one surface still NOT protected, even in the container, is the writable source tree (a malicious install can edit `src/`; `--frozen` locks it). (See [`docs/rfc-native-default.md`](docs/rfc-native-default.md).)

Two design rules govern most decisions:

- **Same keystrokes as the package manager; never invent vocabulary.** Default surface is the friendly verbs (`sandbox install` / `sandbox add zod`) and the `sandbox-<pm>` / `s<pm>` binaries (`sandbox-pnpm add zod` / `spnpm add zod` = vet, then install mode-aware), with the explicit `sandbox <pm>` form (always containerized) as the boundary-on-demand escape hatch. `src/dispatch.ts` translates any PM/runner command into one of a few models (install / add / remove / update / audit / run); `chooseInstallTarget` (`src/mode.ts`) picks native vs container from the detected project mode, `runNativeInstall` (`src/cli.ts`) runs the native path, `src/execute.ts` the container. When you add a capability, prefer making an existing command do the right thing over adding a new command or flag. Auto-detect and mirror the user's package manager; do not ask. **Never shadow the user's real `npm`/`pnpm`** (the removed `path install` takeover is the anti-pattern); they opt in by typing a prefix.
- **Security is invisible until it needs you.** A clean install says almost nothing; a finding is loud and specific. We do not narrate the gates (or the boundary) doing their job.

## Design philosophy: read before adding a feature, flag, or config key

- **Honest docs and honest output.** Never oversell. If something is *not* protected (e.g. the source tree stays writable during an install), say so plainly; see the "NOT protected by default" section of the README. A claim the code can't back is a bug. The egress proxy in particular: describe what it actually blocks, not an idealized version.
- **Human-in-the-loop: action + a plain "why".** Every consequential line tells the user what is about to happen and, in one plain clause, why, so they stay in control. The one decision point that asks (blocked egress) classifies each host with a real reason (`nodejs.org — Node headers for compiling native modules`) so the choice is informed, not a rubber stamp. See `src/hosts.ts` and `src/interactive.ts`.
- **The security gradient is deliberate.** Always on (every path, no Docker needed): `sandbox check`/`preflight` vet target versions before fetch and install nothing. The install then runs **mode-aware**: native on a host-native or fresh project (only as strong as the gates), contained when the tree is already a container build. Force the container (`sandbox <pm>` / devcontainer) and you add the real boundary on demand: credentials, persistence paths, egress allowlist, capabilities. NOT protected even in the container: the writable source tree (a malicious install can edit `src/`; `--frozen` locks it). Don't quietly change where a surface sits on that gradient; those are product decisions the maintainer owns.
- **Don't add a new package manager to the `PackageManager` union casually.** It is `'npm' | 'pnpm' | 'yarn' | 'bun'` and threads through ~a dozen exhaustive switches and `Record<PackageManager, …>` maps. Adding a member is a real, repo-wide change. (We evaluated wrapping `nub` as a runner and removed it: redundant inside the box, couldn't be explained in one sentence, disproportionate routing/test cost. Don't reopen without that bar cleared.)

## Build, test, and run

Package manager is **pnpm**, pinned to `pnpm@11.5.1` (a repo-metadata check enforces the pin; don't bump it casually).

```
pnpm build              # gen:schema → tsdown (writes dist/)
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run  +  pnpm check:repo  (the unit gate)
pnpm test:integration   # builds dist/, runs the golden CLI + Docker tests (slow, opt-in)
pnpm dev -- <args>      # tsx src/cli.ts <args> (run the CLI from source)
```

- **`pnpm check:repo`** runs three repo gates that CI also runs, so run them before pushing:
  - `check:cycles`: no import cycles among `src/` modules.
  - `check:install-policy`: the project's own `pnpm-workspace.yaml` install policy (allowBuilds / release-age) is sound.
  - `check:repo-metadata`: `package.json` keeps `packageManager` pinned and `publishConfig` public + provenance on.
- **Integration tests need Docker** (they self-skip when no runtime is found) and a built `dist/`. Unit tests need neither.
- **`--dry-run` is your no-Docker inspection tool.** `pnpm dev -- --dry-run pnpm add zod` prints the resolved plan (mounts, network, grants) without building or running anything. Use it to verify routing and containment changes fast.
- **No shell takeover.** The tool never shadows your `npm`/`pnpm`/`yarn`/`bun`, so bare commands run the repo's own toolchain as normal. To route a command through sandbox you type it explicitly: `sandbox pnpm install` (always container), or the per-PM binaries `sandbox-pnpm`/`spnpm` (vet, then install mode-aware: native on a host-native or fresh project, contained when the tree is already a container build).

## Code conventions

- **`src/cli.ts` self-executes `main()` at module load, so it cannot be imported in a test.** The pattern the whole codebase follows: push every decision worth testing OUT of `cli.ts` into a sibling module as a **pure function**, and unit-test that. `cli.ts` becomes a thin wiring layer that calls pure deciders and routes their output to effects. Examples already in the tree: `doctorSummary`/`autoFixActions` (`doctor.ts`), `classifyHost`/`buildHostSuffixes` (`hosts.ts`), `buildNotice` (`build-progress.ts`), `nextPlanForBlockedEgressChoice` (`interactive.ts`), `formatEvent` (`log.ts`), `routePassthrough`/`isGlobalInstall` (`dispatch.ts`), `parsePnpmWorkspacePolicy` (`repo-checks/install-policy.ts`). When you add behavior to the CLI, add the *decision* as a pure exported function with tests, and call it from `cli.ts`.
- **Exhaustive switches are a feature; lean on them.** Switches over `PackageManager` and over `Route['model']` have no `default`, so adding a union member makes `tsc` enumerate every site you must update. Use `pnpm typecheck` as the checklist; never paper over it with a `default` arm.
- **Logging goes through `src/log.ts`.** `log.info/warn/error/debug` write `sandbox:`-prefixed lines to **stderr** (so stdout stays clean for `--json` / receipts). `✓`/`⚠`/`✖` come from the level, not hand-typed prefixes. `SANDBOX_LOG=json` switches to NDJSON; keep new events expressible in both.
- **Comments explain WHY.** This codebase is comment-dense with rationale (why this host is allowed, why pnpm keeps a writable root when frozen, why a verb routes install-class). Match that: explain the non-obvious reason, not the obvious what.
- **Plans are immutable.** `src/plan.ts` builds a `RunPlan`; runtime variation rides the `RunOverride` seam in `execute.ts`, not plan mutation.

## The output voice (load-bearing for DX)

This is the product's personality. Hold the bar:

- **Action + plain why, in one line.** Not "continuing inside containment" (jargon) but "running in a throwaway container, so this code can't reach your credentials or home dir" or, after a contained install on macOS/Windows, "node_modules targets the Linux container; run tools with `sandbox test`, or your own install for a host-native tree."
- **Invisible when clean, clear when it matters.** A gate that finds nothing should stay quiet (debug), not narrate. A gate that finds something leads with what and why, and states the reason once, never repeating a reassurance on every line.
- **The escape hatch is always one keystroke away and always named:** `command <tool>`, `SANDBOX_OFF=1`, `sandbox off`. Never trap the user.
- **No em dashes in user-facing text.** House punctuation uses periods, commas, colons, and parentheses instead. Be terse and confident; cut filler. This covers the docs site, the README, and the CLI output/help strings in `src/`, so doc transcripts of real output match the binary. Code comments may keep em dashes as internal rationale.

## Repo layout

- `src/`: ~50 single-concern modules. Entry: `cli.ts` (argv parse + dispatch + effects). Routing: `dispatch.ts`. Plans/containment: `plan.ts`, `execute.ts`, `backend.ts`, `network.ts`. Supply-chain: `risk.ts`, `preflight.ts`, `advisory.ts`, `scan.ts`, `delta.ts`. Config: `config.ts`, `presets.ts`, `init.ts`, `setup.ts`. Surfaces: `doctor.ts`, `verify.ts`, `receipt.ts`, `secrets.ts`, `native.ts`, `mode.ts`, `hosts.ts`, `interactive.ts`, `log.ts`.
- `src/repo-checks/`: the logic behind `pnpm check:repo` (import cycles, install policy, manifest metadata).
- `test/`: unit tests (fast, no Docker). `test/integration/`: golden CLI + Docker tests (opt-in, slow).
- `scripts/`: `gen-schema.ts` (regenerates `sandbox.schema.json`), `gen-top-packages.mjs` (typosquat corpus), the three `check-*.ts` repo gates.
- `proxy/` + `net-guard.sh` + `Dockerfile`: the container image and the default-deny egress proxy. Touch with care; covered by `SECURITY.md`.
- `data/`: bundled data (top packages, etc.). `skills/`: agent skills for *using* sandbox (see below). `docs/reference.md`: full reference.

## Skills (`skills/`)

These are skills for agents that *use* sandbox, not for working on this repo. Three, one per workflow:

- [`sandbox-install`](skills/sandbox-install/SKILL.md): the flagship: human-in-the-loop install (review with `check`, map findings to recommended actions, install with only the approved overrides). Has its own `REFERENCE.md`.
- [`sandbox-agent-isolation`](skills/sandbox-agent-isolation/SKILL.md): contain the agent itself (host PreToolUse hook via `init --agent`, or `devcontainer init`).
- [`sandbox-ci`](skills/sandbox-ci/SKILL.md): the read-only CI/cron gates (`verify`, `delta`, `scan`, `secrets`).

When you change a gate, a flag, a finding format, or a command surface, update the affected skill in the same change; a stale skill teaches the wrong flags. Keep flags cited in skills real (cross-check against `cli.ts` / `docs/reference.md`).

## Releasing

[Changesets](https://github.com/changesets/changesets). **Any user-facing change needs a changeset** (`pnpm changeset`) in the same PR; describe the change in user terms. Releases are PR-driven (the `chore: release` PR runs `changeset version` + publish); publishing is public with npm provenance. Don't hand-edit `CHANGELOG.md` or version fields.

## Branch and commit workflow

- Work on a feature branch named `feat/<name>` (or `fix/<name>`/`docs/<name>`), branched off `main`; open a PR into `main`. Do not commit straight to `main`.
- Commit small and often, with factual conventional-commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`). State what changed, not how good it is.
- Keep the boundary green: `pnpm test` (unit + repo checks) before pushing; run `pnpm test:integration` when you touched containment, mounts, egress, or the image.
