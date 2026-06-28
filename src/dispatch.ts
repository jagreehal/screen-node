import type { PackageManager } from './package-manager.js';

/**
 * The transparent pass-through surface: `sandbox <command…>` where `<command>` is a
 * package manager or runner the user already knows. We translate it to one of the
 * three containment models — install / add / run — so the user never learns our
 * command vocabulary; they put `sandbox` in front of what they'd type anyway.
 *
 * `install`/`add`/`remove` carry the explicitly-named `pm` so `sandbox pnpm add zod`
 * honours pnpm even if the lockfile probe would have guessed otherwise; `run` carries
 * the literal argv so it executes verbatim.
 */
export type Route =
  | { model: 'install'; pm: PackageManager; frozen: boolean; args: string[] }
  | { model: 'add'; pm: PackageManager; pkgs: string[] }
  | { model: 'remove'; pm: PackageManager; pkgs: string[] }
  | { model: 'update'; pm: PackageManager; verb: string; args: string[] }
  | { model: 'auditFix'; pm: PackageManager; fixToken: string; args: string[] }
  | { model: 'auditSignatures'; pm: PackageManager; args: string[] }
  | { model: 'audit'; argv: string[] }
  | { model: 'run'; argv: string[] };

/** Package managers we route by verb (install/add/frozen) rather than running raw. */
const PM_LEADERS: Record<string, PackageManager> = { npm: 'npm', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun' };

/**
 * Verbs that pull NEWER versions of existing deps — install-class, so they get registry egress and
 * the supply-chain gates (release-age, OSV, deprecation, risk). Per-PM, deliberately: `bun upgrade`
 * upgrades the bun BINARY (not packages), so it must NOT land here — it stays a plain `run`.
 */
const UPDATE_VERBS: Record<PackageManager, Set<string>> = {
  npm: new Set(['update', 'up', 'upgrade']),
  pnpm: new Set(['update', 'up', 'upgrade']),
  yarn: new Set(['upgrade', 'up']),
  bun: new Set(['update']),
};

/**
 * `dedupe` reorganises the installed tree to share versions. It re-resolves against the registry to
 * find dedupable versions, so it's install-class (registry egress), a no-network `run` can't do it.
 * It rides the `update` model (it can pull newer in-range versions, same as an update). bun has no
 * dedupe; yarn's lives in Berry. npm also spells it `ddp`.
 */
const DEDUPE_VERBS: Record<PackageManager, Set<string>> = {
  npm: new Set(['dedupe', 'ddp']),
  pnpm: new Set(['dedupe']),
  yarn: new Set(['dedupe']),
  bun: new Set(),
};

/**
 * Verbs that DROP a dependency — a deliberate manifest change like `add`, so it gets the same
 * write-class containment (manifest writable, persistence locked, host creds out). It pulls nothing
 * NEW from the registry, so unlike `add`/`update` there's no supply-chain surface to gate. Each PM's
 * own aliases: npm `uninstall`/`remove`/`rm`/`un`, pnpm `remove`/`rm`/`uninstall`/`un`, yarn `remove`,
 * bun `remove`/`rm`. (`unlink` is excluded — it un-symlinks a linked package, a different operation.)
 */
const REMOVE_VERBS: Record<PackageManager, Set<string>> = {
  npm: new Set(['uninstall', 'remove', 'rm', 'un']),
  pnpm: new Set(['remove', 'rm', 'uninstall', 'un']),
  yarn: new Set(['remove']),
  bun: new Set(['remove', 'rm']),
};

/** Other leaders that are always a `run` (dev servers, monorepo task runners, one-off tools, scripts).
 *  `bunx` is bun's fetch-and-run runner (≈ `npx`); the `bun` package-manager verbs are routed above.
 *  `turbo`/`nx` are the monorepo task runners, so `sandbox turbo dev` / `sandbox nx build` work directly
 *  (they resolve from node_modules/.bin in the container, same as `vite`/`next`). */
const RUN_LEADERS = new Set(['npx', 'pnpx', 'pnpm-exec', 'yarn-dlx', 'bunx', 'node', 'tsx', 'deno', 'vite', 'next', 'astro', 'turbo', 'nx']);

const FROZEN_FLAGS = new Set(['--frozen-lockfile', '--immutable']);

function pnpmAuditFix(rest: string[]): Route | undefined {
  const index = rest.findIndex((token) => token === '--fix' || token.startsWith('--fix='));
  if (index === -1) return undefined;
  return {
    model: 'auditFix',
    pm: 'pnpm',
    fixToken: rest[index]!,
    args: rest.filter((_, i) => i !== index),
  };
}

/** A positional (non-flag) token after the verb means packages were named → it's an add. */
function hasPositional(args: string[]): boolean {
  return args.some((a) => a.length > 0 && !a.startsWith('-'));
}

function routePm(pm: PackageManager, rest: string[]): Route {
  const verb = rest[0];
  const after = rest.slice(1);

  // Bare `yarn` is `yarn install`; bare `npm`/`pnpm` just print help → run them.
  if (verb === undefined) return pm === 'yarn' ? { model: 'install', pm, frozen: false, args: [] } : { model: 'run', argv: [pm] };

  if (verb === 'add') return { model: 'add', pm, pkgs: after };
  if (pm === 'npm' && verb === 'ci') return { model: 'install', pm, frozen: true, args: after };
  if (pm === 'npm' && verb === 'audit' && after[0] === 'fix') return { model: 'auditFix', pm, fixToken: 'fix', args: after.slice(1) };
  if (pm === 'npm' && verb === 'audit' && after[0] === 'signatures') return { model: 'auditSignatures', pm, args: after.slice(1) };
  if (pm === 'pnpm' && verb === 'audit') {
    const route = pnpmAuditFix(after);
    if (route) return route;
    if (after[0] === 'signatures') return { model: 'auditSignatures', pm, args: after.slice(1) };
  }
  // Report-only audit (`npm/pnpm/yarn/bun audit`, no fix): installs nothing, but needs the registry
  // advisory endpoint — so a read-only run with registry egress, not the default no-network run.
  if (verb === 'audit') return { model: 'audit', argv: [pm, ...rest] };

  if (verb === 'install' || verb === 'i') {
    // `npm install lodash`, `pnpm i -D zod` → adding deps (writes the manifest).
    if (hasPositional(after)) return { model: 'add', pm, pkgs: after };
    return { model: 'install', pm, frozen: after.some((a) => FROZEN_FLAGS.has(a)), args: after };
  }

  // `npm update` / `pnpm up` / `yarn upgrade` / `bun update` → pulls newer versions: gate it.
  if (UPDATE_VERBS[pm].has(verb)) return { model: 'update', pm, verb, args: after };

  // `npm/pnpm/yarn dedupe` → re-resolves the tree; install-class so it reaches the registry.
  if (DEDUPE_VERBS[pm].has(verb)) return { model: 'update', pm, verb, args: after };

  // `npm uninstall` / `pnpm remove` / `yarn remove` / `bun rm` → drop a dep inside containment.
  if (REMOVE_VERBS[pm].has(verb)) return { model: 'remove', pm, pkgs: after };

  // run/test/dev/start/exec/dlx/… → run the command exactly as typed.
  return { model: 'run', argv: [pm, ...rest] };
}

/**
 * Classify a pass-through command. Returns `undefined` when the leading token isn't a
 * recognized package manager or runner — the caller then treats it as an unknown
 * sandbox subcommand.
 */
export function routePassthrough(argv: string[]): Route | undefined {
  const [leader, ...rest] = argv;
  if (leader === undefined) return undefined;
  if (leader in PM_LEADERS) return routePm(PM_LEADERS[leader]!, rest);
  if (RUN_LEADERS.has(leader)) return { model: 'run', argv };
  return undefined;
}

/** Package specifiers and bin names that mean "the screen CLI itself". */
const SELF_PACKAGE = '@jagreehal/screen-node';

/** True for `@jagreehal/screen-node`, `@jagreehal/screen-node@latest`, `screen-node@1.2.3`, etc. */
function isSelfPackageToken(token: string): boolean {
  const at = token.lastIndexOf('@');
  const name = at > 0 ? token.slice(0, at) : token; // keep the scope's leading '@'; drop any version suffix
  return name === SELF_PACKAGE || name === 'screen-node';
}

/** Fetch-and-run runners (npx-family) — the surface that can end up wrapping our OWN CLI. */
const SELF_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'dlx', 'exec', 'x']);

/**
 * Don't sandbox sandbox. A wrapper or alias can route `npx` through us, so
 * `npx @jagreehal/sandbox-node check lodash` arrives as `sandbox npx @jagreehal/sandbox-node check
 * lodash` — which would otherwise fetch-and-run our OWN CLI inside a network-less container and die
 * with a DNS error, never reaching `check`. Detect that shape and unwrap it to the bare subcommand
 * (`check lodash`), which the already-running CLI runs directly. Returns the unwrapped argv, or
 * undefined when this isn't a self-invocation.
 */
export function unwrapSelfInvocation(argv: string[]): string[] | undefined {
  const runnerAt = argv.findIndex((t) => SELF_RUNNERS.has(t));
  if (runnerAt === -1) return undefined;
  let i = runnerAt + 1;
  while (i < argv.length && argv[i]!.startsWith('-')) i++; // skip runner flags like -y / --yes
  if (i >= argv.length || !isSelfPackageToken(argv[i]!)) return undefined;
  return argv.slice(i + 1).filter((t) => t !== '--'); // drop a `--` separator (e.g. `npm exec pkg -- args`)
}

/**
 * True for a global install across any package manager — a host-tooling action a container can't
 * perform (a `-g` install in an ephemeral container installs nothing on the host). npm/pnpm/bun use
 * a flag (`-g` / `--global` / `--location=global`); yarn classic uses a `global` subcommand
 * (`yarn global add …`), which routes to `run`, so match it explicitly on the leading token.
 */
export function isGlobalInstall(cmd: string, route: Route, args: string[]): boolean {
  const installClass = route.model === 'install' || route.model === 'add' || route.model === 'remove' || route.model === 'update';
  if (installClass && args.some((a) => a === '-g' || a === '--global' || a === '--location=global')) return true;
  if (cmd === 'yarn' && args[0] === 'global') return true;
  return false;
}

/**
 * The package manager a route will actually run under. `sandbox npm install` in a pnpm repo runs
 * npm, so the gates, the `--deep` lockfile read, and every remediation/pin line must follow npm
 * (route.pm), not the repo-probed pm, exactly as the plan threads route.pm through. Argv-only routes
 * (audit/run) carry no pm, so they fall back to the repo's detected one (`repoPm`). Exhaustive over
 * `Route['model']` (no `default`) so a new model forces a decision here.
 */
export function effectivePm(route: Route, repoPm: PackageManager): PackageManager {
  switch (route.model) {
    case 'install':
    case 'add':
    case 'remove':
    case 'update':
    case 'auditFix':
    case 'auditSignatures':
      return route.pm;
    case 'audit':
    case 'run':
      return repoPm;
  }
}

/**
 * The package manager for a route that mutates `node_modules` (install/add/update/remove/auditFix), or
 * undefined when the route writes no tree (read-only audit/run). Drives the mode-aware write path: which
 * routes pick native vs container, and the cross-mode warning before a forced-container write. `remove`
 * is included because dropping a dependency rewrites the tree too and must stay in the project's one
 * mode. Exhaustive over `Route['model']` (no `default`) so a new model forces a decision here.
 */
export function modeAwareWritePm(route: Route): PackageManager | undefined {
  switch (route.model) {
    case 'install':
    case 'add':
    case 'update':
    case 'auditFix':
    case 'remove':
      return route.pm;
    case 'auditSignatures':
    case 'audit':
    case 'run':
      return undefined;
  }
}

/**
 * The present-progressive verb for a route's action line ("installing", "removing", …), so the one-line
 * write announcement names the actual operation instead of always saying "installing" (a `remove`
 * shouldn't announce an install). Exhaustive over `Route['model']` (no `default`); the read-only models
 * never reach the write action line but are mapped to a sensible word for completeness.
 */
export function writeVerb(route: Route): string {
  switch (route.model) {
    case 'install':
      return 'installing';
    case 'add':
      return 'adding';
    case 'update':
      return 'updating';
    case 'remove':
      return 'removing';
    case 'auditFix':
      return 'fixing';
    case 'auditSignatures':
    case 'audit':
    case 'run':
      return 'running';
  }
}
