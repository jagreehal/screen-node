import { spawnSync } from 'node:child_process';
import type { SandboxConfig } from './config.js';
import type { ProjectContext } from './context.js';
import { writeVerb, type Route } from './dispatch.js';
import { fail } from './fail.js';
import type { Globals } from './globals.js';
import { log } from './log.js';
import { writeActionLine } from './mode.js';
import { detectProjectMode, hostPlatform } from './native-deps.js';
import { argvRunsPnpm, findPendingBuilds, planBuildApproval, promptBuildApprovals, renderApproveBuildsCommand, writeBuildApprovals } from './build-approval.js';
import { frozenInstallArgv, lockfileName, pmArgv, pmAuditFixArgv, pmAuditSignaturesArgv, pmUpdateArgv } from './package-manager.js';
import type { ProjectFacts } from './project.js';
import { renderSandboxRetry } from './retry.js';
import { classifyCommand } from './tamper.js';

/**
 * Per-invocation options for a write/install. `frozen` opts into a reproducible install (overrides
 * `config.install.frozen`); `envNames`/`workdir` are carried through for parity with the CLI surface.
 */
export interface PlanOptions {
  frozen?: boolean;
  workdir?: string;
  envNames?: string[];
}

/**
 * Everything the write/install orchestration needs from `main()`, bundled so the path can live outside
 * the self-executing `cli.ts` and be unit-tested. `cmd`/`args`/`binLeader` identify how the user
 * invoked us (for the build-approval retry guidance).
 */
export interface WriteContext {
  config: SandboxConfig;
  facts: ProjectFacts;
  opts: PlanOptions;
  globals: Globals;
  project: ProjectContext;
  cmd: string;
  args: string[];
  binLeader: string | undefined;
}

/** The effective frozen flag for a route: the route's own, else the per-run override, else config. */
export function resolvedFrozen(route: Route, opts: PlanOptions, config: SandboxConfig): boolean {
  return (route.model === 'install' && route.frozen) || (opts.frozen ?? config.install.frozen);
}

/** A frozen install needs a committed lockfile for the (possibly explicitly-named) pm. */
export function requireLockfileForFrozen(facts: ProjectFacts, frozen: boolean): void {
  if (frozen && !facts.hasLockfile) {
    const lf = lockfileName(facts.pm);
    fail(`reproducible install needs a committed ${lf}, run \`sandbox ${facts.pm} install <pkg>\` to create one, or drop --frozen`);
  }
}

/**
 * The host argv for a resolved route, built from the route (not the raw input) so the gate engine's
 * safe-install substitution/pins (in `route.pkgs`/`route.args`) stay intact. With `frozen`, the install
 * case uses the reproducible-install argv. Exhaustive over `Route['model']` (no `default`) so a new
 * model forces a decision here.
 */
export function routeToHostArgv(route: Route, opts: { frozen?: boolean; yarnBerry?: boolean } = {}): string[] {
  switch (route.model) {
    case 'install': return opts.frozen ? frozenInstallArgv(route.pm, opts.yarnBerry ?? false, route.args) : pmArgv(route.pm, 'install', route.args);
    case 'add': return pmArgv(route.pm, 'add', route.pkgs);
    case 'remove': return pmArgv(route.pm, 'remove', route.pkgs);
    case 'update': return pmUpdateArgv(route.pm, route.verb, route.args);
    case 'auditFix': return pmAuditFixArgv(route.pm, route.fixToken, route.args);
    case 'auditSignatures': return pmAuditSignaturesArgv(route.pm, route.args);
    case 'audit':
    case 'run': return route.argv;
  }
}

/**
 * Run an argv natively on the host (no container). The gate engine already vetted the route; a native
 * install runs lifecycle scripts on the host, so this is heuristic screening, not a hard boundary.
 * Honours --dry-run/--json (describe and return without running).
 */
function runNative(argv: string[], cwd: string, globals: Globals, action: string): number {
  if (globals.dryRun) {
    console.log(`sandbox: would run natively on the host, no container:\n  ${argv.join(' ')}`);
    return 0;
  }
  if (globals.json) {
    console.log(JSON.stringify({ native: true, host: true, argv }, null, 2));
    return 0;
  }
  if (action) log.info(action); // empty on a build-approval re-run, so the action line prints once
  const [program, ...rest] = argv;
  const result = spawnSync(program!, rest, { cwd, stdio: 'inherit' });
  if (result.error) fail(`could not run '${program}' on the host: ${result.error.message}`);
  return result.status ?? 1;
}

/**
 * Post-install build-approval resolution for the native write path (pnpm refuses unknown dependency
 * build scripts and records them under `allowBuilds:` in pnpm-workspace.yaml as undecided). Resolve
 * via `--allow-all-builds`, an interactive prompt, or one-line guidance, then a re-run. Keys off the pm
 * in `argv` (not the repo's detected one). Returns 'rerun' (approvals written, install again),
 * { block } (unresolved, surface non-zero), or 'ok' (nothing pending).
 */
async function resolveBuildApprovals(ctx: WriteContext, argv: string[], installCode: number): Promise<'rerun' | { block: number } | 'ok'> {
  const isPnpmInstall = argvRunsPnpm(argv) && classifyCommand(argv) !== 'other';
  const pending = isPnpmInstall ? findPendingBuilds(ctx.project.rootDir) : [];
  const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !ctx.globals.json && !ctx.globals.dryRun;
  const decision = planBuildApproval({ pendingCount: pending.length, isPnpmInstall, allowAll: ctx.globals.allowAllBuilds, canPrompt });
  const where = 'on the host';
  switch (decision) {
    case 'none':
      return 'ok';
    case 'approve-all': {
      const r = writeBuildApprovals(ctx.project.rootDir, new Map(pending.map((n) => [n, true])));
      log.info(`approved build scripts (${where}): ${r.allowed.join(', ')}; re-running install`);
      return 'rerun';
    }
    case 'prompt': {
      const decisions = await promptBuildApprovals(pending, false);
      if (decisions) {
        const r = writeBuildApprovals(ctx.project.rootDir, decisions);
        const parts = [r.allowed.length ? `allowed ${r.allowed.join(', ')}` : '', r.denied.length ? `denied ${r.denied.join(', ')}` : ''].filter(Boolean);
        log.info(`updated pnpm-workspace.yaml (${parts.join('; ')}), re-running install`);
        return 'rerun';
      }
      // Cancelled the prompt: fall through to the same guidance as no-TTY, so nothing builds silently.
      break;
    }
    case 'guide':
      break;
  }
  log.warn(`${pending.length} package(s) want to run install scripts but aren't approved yet: ${pending.join(', ')}`);
  log.info(`approve (${where}) and re-install:  ${renderApproveBuildsCommand(pending)}`);
  log.info(`or approve all without prompting:  ${renderSandboxRetry('--allow-all-builds', ctx.cmd, ctx.args)}`);
  return { block: installCode === 0 ? 1 : installCode };
}

/**
 * Native install with the post-install build-approval loop: run on the host, then resolve pnpm's
 * undecided build scripts and re-run. Honours `--frozen` (lockfile invariant + reproducible argv).
 * --dry-run/--json describe and return without an approval loop (nothing installed).
 */
async function runNativeWrite(ctx: WriteContext, route: Route, action: string): Promise<number> {
  const frozen = resolvedFrozen(route, ctx.opts, ctx.config);
  if (route.model === 'install') requireLockfileForFrozen({ ...ctx.facts, pm: route.pm }, frozen);
  const argv = routeToHostArgv(route, { frozen, yarnBerry: ctx.facts.isYarnBerry });
  let code = runNative(argv, ctx.facts.cwd, ctx.globals, action);
  if (ctx.globals.dryRun || ctx.globals.json) return code;
  for (let tries = 0; tries < 3; tries++) {
    const ba = await resolveBuildApprovals(ctx, argv, code);
    if (ba === 'rerun') {
      code = runNative(argv, ctx.facts.cwd, ctx.globals, ''); // action printed once, above
      continue;
    }
    if (typeof ba === 'object') return ba.block;
    return code; // 'ok'
  }
  return code;
}

/**
 * The single write entry point, shared by `sandbox install`/`add`/`update`/`remove`/`run`/`audit`, the
 * per-PM bins, `approve-builds` (its re-install), and `upgrade --write`. Every route runs natively on
 * the host: the gate engine vets target versions before fetch, then the package manager runs directly.
 * One place owns the native path, so every write surface agrees.
 */
export async function runWrite(ctx: WriteContext, route: Route): Promise<number> {
  const { facts } = ctx;
  // Read-only routes (run/audit) carry no tree to place: run them natively with no action banner.
  if (route.model === 'run' || route.model === 'audit') {
    return runNative(routeToHostArgv(route), facts.cwd, ctx.globals, '');
  }
  const host = hostPlatform();
  const mode = detectProjectMode(facts.cwd, host);
  // One action line before any write: the operation, the pm, the mode, the one plain why.
  const action = writeActionLine({ verb: writeVerb(route), pm: route.pm, mode });
  return runNativeWrite(ctx, route, action);
}
