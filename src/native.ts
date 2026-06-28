/**
 * The `screen-<pm>` / `s<pm>` binaries are muscle-memory front-ends for the friendly write path: same
 * keystrokes as the package manager, vetted by the gate engine, then installed mode-aware (native on a
 * host-native or fresh project, contained when the tree is already a container build). `screen-pnpm add
 * zod` (or `spnpm add zod`) is the exact keystrokes of `pnpm add zod`. They are mode-aware, unlike the
 * explicit `screen <pm>` form, which always containerizes (the boundary on demand). Your real `pnpm` is
 * never shadowed; you opt in by typing the prefix. See docs/rfc-native-default.md for the one-mode-per-project model.
 *
 * In a published install each bin name is a tiny launcher in `bin/` that sets `SCREEN_PM_BIN` and
 * imports the CLI, so the leader survives a package-manager shim that loses argv[0]. `leaderForBin`
 * is the fallback for running the bundle directly under a `screen-<pm>`-named symlink (dev/test).
 */

/**
 * The bin names we ship alongside `screen`, each mapping to the package-manager/runner it fronts.
 * Both the explicit `screen-<pm>` form and a terse `s<pm>` alias, so it's pure muscle memory
 * (`spnpm add zod` ≈ `pnpm add zod`) and you opt in by typing it. We never shadow the real PM.
 */
const BIN_LEADER: Record<string, string> = {
  'screen-npm': 'npm',
  'screen-pnpm': 'pnpm',
  'screen-yarn': 'yarn',
  'screen-bun': 'bun',
  'screen-npx': 'npx',
  'screen-bunx': 'bunx',
  snpm: 'npm',
  spnpm: 'pnpm',
  syarn: 'yarn',
  sbun: 'bun',
  snpx: 'npx',
  sbunx: 'bunx',
};

/**
 * When invoked as one of the `screen-<pm>` binaries, the leader to prepend to argv so the existing
 * pass-through router handles it: `screen-pnpm add zod` (argv `['add','zod']`) becomes the route for
 * `pnpm add zod`. Returns undefined for the plain `screen`/`screen-node` bins (and when run from
 * source as `cli.ts`), which keep their normal dispatch.
 */
export function leaderForBin(binName: string): string | undefined {
  // Tolerate a `.mjs`/`.js`/`.cmd` suffix (Windows shims) and any directory prefix.
  const base = binName.replace(/\.(mjs|cjs|js|cmd|exe|ps1)$/i, '');
  return BIN_LEADER[base];
}

/**
 * Fold a `screen-<pm>` leader back into a parsed argv so the normal pass-through router handles it.
 * The leader (e.g. `pnpm`) is implicit in the bin name, so the parsed command (`add`) is really the
 * package manager's first argument: `spnpm add zod` (parsed `{cmd:'add', args:['zod']}`) becomes
 * `{cmd:'pnpm', args:['add','zod']}`, i.e. the route for `pnpm add zod`, with global flags intact.
 * No leader (plain `screen`) passes the parse through unchanged. Pure so the fold (and its
 * `cmd === undefined` edge, a bare `spnpm`) is unit-tested instead of buried in `main()`.
 */
export function foldBinLeader(
  binLeader: string | undefined,
  parsed: { cmd?: string; args: string[] },
): { cmd?: string; args: string[] } {
  if (binLeader === undefined) return { cmd: parsed.cmd, args: parsed.args };
  const args = parsed.cmd !== undefined ? [parsed.cmd, ...parsed.args] : parsed.args;
  return { cmd: binLeader, args };
}
