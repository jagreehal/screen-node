# AGENTS.md: agent orientation for the screen-node repo

Entry point for AI coding agents working in this repository. Follows the
[`AGENTS.md` convention](https://agents.md); [`CLAUDE.md`](CLAUDE.md) is a symlink
to this file.

## The one job: keep it in view

`screen-node` **screens a dependency install before it fetches anything**, then
installs **natively on the host**. Before an install runs, it checks the target
versions against known-bad advisories (OSV malware + your feeds, a hard block),
typosquats, the release-age worm window (with a safe-install substitution), and
deprecation. Same keystrokes as the package manager, with an `s` prefix: `snpm`,
`spnpm`, `syarn`, `sbun`, `snpx`, `sbunx` (`s` = screen), plus `screen <verb>`
(`check`, `install`, `add`, `doctor`, `verify`, ...).

The honest line, hold it everywhere: **it is a fast filter, not a cage.** Native
installs run lifecycle scripts on the host, so the gates are heuristics, not a
boundary. There is no container here (the real boundary lives in the sibling
project, [sandbox-claude](https://github.com/jagreehal/sandbox-claude); the two
compose: screen inside the cage). Never claim isolation screen-node doesn't have.
See [`SECURITY.md`](SECURITY.md).

Two design rules govern most decisions:

- **Same keystrokes as the package manager; never invent vocabulary.** `src/dispatch.ts`
  translates any PM/runner command into one of a few models (install / add / remove /
  update / audit / run); the write path screens then installs natively.
- **Security is invisible until it needs you.** A clean install says almost nothing
  (debug); a finding is loud and specific, and recommends an action you approve.

## Build, test, and run

Package manager is **pnpm**, pinned to `pnpm@11.5.1`.

```
pnpm build        # gen:schema (writes screen.schema.json) → tsdown (writes dist/)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run + pnpm check:repo (the unit gate)
pnpm dev -- <args># tsx src/cli.ts <args> (run the CLI from source)
```

- **`pnpm check:repo`** runs three repo gates CI also runs: no import cycles,
  install-policy sound, manifest metadata (pnpm pinned, publishConfig public +
  provenance). Run before pushing.
- **`--dry-run` is your no-install inspection tool.** `pnpm dev -- --dry-run snpm install`
  prints the resolved plan without fetching or running anything.

## Code conventions

- **`src/cli.ts` self-executes `main()` at module load, so it cannot be imported in a
  test.** Push every decision worth testing OUT of `cli.ts` into a sibling module as a
  **pure function**, and unit-test that. `cli.ts` is a thin wiring layer. Because it is
  untested, **smoke-test CLI behavior manually** after changing it (`node dist/cli.mjs
  check zod`, `--dry-run install`, `SCREEN_OFF=1 ...`).
- **Exhaustive switches are a feature.** Switches over `PackageManager` and
  `Route['model']` have no `default`, so adding a member makes `tsc` enumerate every
  site. Use `pnpm typecheck` as the checklist.
- **Logging goes through `src/log.ts`** — `screen:`-prefixed lines to stderr (stdout
  stays clean for `--json`). `SCREEN_LOG=json` switches to NDJSON.
- **Comments explain WHY.** Match the comment-dense, rationale-first style.
- **No em dashes in user-facing text.** Periods, commas, colons, parentheses instead.

## Repo layout

- `src/`: gate engine — `risk.ts` (the heart), `advisory.ts`, `preflight.ts`,
  `scan.ts`, `delta.ts`, `safe-install.ts`, `known-bad.ts`, `registry.ts`,
  `runtime-cve.ts`, `tamper.ts`, `secrets.ts`. Native install — `native.ts`,
  `native-deps.ts`, `mode.ts`, `write.ts`. Routing — `dispatch.ts`. Surfaces —
  `cli.ts` (entry), `doctor.ts`, `verify.ts`, `receipt.ts`, `init.ts`, `setup.ts`,
  `config.ts`, `log.ts`.
- `src/repo-checks/`: the logic behind `pnpm check:repo`.
- `test/`: unit tests (fast, no Docker). `test/integration/`: golden CLI tests (opt-in).
- `scripts/`: `gen-schema.ts`, `gen-top-packages.mjs`, the `check-*.ts` repo gates.

## History and follow-ups

`screen-node` was extracted from `@jagreehal/sandbox-node` and had its Docker/container
subsystem removed (it is now container-free). The rename to `screen` is complete:
env vars use the `SCREEN_*` prefix (e.g. `SCREEN_LOG`), on-disk paths use the `screen`
name (`screen.advisories.json`, the `.screen` agent dir), and the `test/integration/`
golden tests no longer reference removed container flags.

## Releasing

[Changesets](https://github.com/changesets/changesets). Any user-facing change needs a
changeset in the same PR. Releases are PR-driven; publishing is public with npm
provenance. Don't hand-edit `CHANGELOG.md` or version fields.
