import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import { type ContainerBackend } from './backend.js';
import { argvRunsPnpm, findPendingBuilds, planBuildApproval, promptBuildApprovals, renderApproveBuildsCommand, writeBuildApprovals } from './build-approval.js';
import { makeCanary } from './canary.js';
import type { SandboxConfig } from './config.js';
import type { ProjectContext } from './context.js';
import { modeAwareWritePm, writeVerb, type Route } from './dispatch.js';
import { renderPlanSummary } from './dryrun.js';
import { quiet } from './exec.js';
import { execute, type ExecuteResult } from './execute.js';
import { fail } from './fail.js';
import type { Globals } from './globals.js';
import { canPromptInteractively, nextPlanForBlockedEgressChoice, promptForBlockedEgress } from './interactive.js';
import { log } from './log.js';
import { chooseInstallTarget, crossModeWarning, writeActionLine } from './mode.js';
import { detectProjectMode, hostPlatform } from './native-deps.js';
import { networkPolicy } from './network.js';
import { frozenInstallArgv, isPackageManagerName, lockfileName, pmArgv, pmAuditFixArgv, pmAuditSignaturesArgv, pmUpdateArgv } from './package-manager.js';
import { planAdd, planAudit, planAuditFix, planAuditSignatures, planInstall, planRemove, planRun, planUpdate, type PlanOptions, type RunPlan } from './plan.js';
import type { ProjectFacts } from './project.js';
import { allowHosts, allowHostsLocal, projectRegistryHints } from './registry.js';
import { renderSandboxRetry } from './retry.js';
import { execPackageTargets } from './risk.js';
import { backendDownGuidance } from './setup.js';
import { classifyCommand, containedSuccessLine } from './tamper.js';

/** Env keys safe to show in a `--json` plan dump; everything else is redacted so secrets never leak. */
const JSON_SAFE_ENV = new Set(['SANDBOX', 'CI', 'HOME', 'SSH_AUTH_SOCK', 'HOST']);

/**
 * Everything the write/install orchestration needs from `main()`, bundled so the path can live outside
 * the self-executing `cli.ts` and be unit-tested with a fake backend. `cmd`/`args`/`binLeader` identify
 * how the user invoked us (the explicit `sandbox <pm>` force-container signal, and the build-approval
 * retry guidance).
 */
export interface WriteContext {
  config: SandboxConfig;
  facts: ProjectFacts;
  opts: PlanOptions;
  globals: Globals;
  project: ProjectContext;
  backend: ContainerBackend;
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
 * case uses the reproducible-install argv, so the native path honours `--frozen` exactly like the
 * contained one. Exhaustive over `Route['model']` (no `default`) so a new model forces a decision here.
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
 * Turn a {@link Route} into a container plan. install/add honour the pm the user actually typed
 * (`sandbox pnpm add zod` stays pnpm regardless of the lockfile probe); run executes the command
 * verbatim. The frozen-needs-a-lockfile invariant lives here, the one planning seam.
 */
export function planForRoute(route: Route, config: SandboxConfig, facts: ProjectFacts, opts: PlanOptions): RunPlan {
  switch (route.model) {
    case 'install': {
      const f = { ...facts, pm: route.pm };
      const frozen = resolvedFrozen(route, opts, config);
      requireLockfileForFrozen(f, frozen);
      return planInstall(config, f, route.args, { ...opts, frozen });
    }
    case 'add':
      return planAdd(config, { ...facts, pm: route.pm }, route.pkgs, opts);
    case 'remove':
      return planRemove(config, { ...facts, pm: route.pm }, route.pkgs, opts);
    case 'update':
      return planUpdate(config, { ...facts, pm: route.pm }, pmUpdateArgv(route.pm, route.verb, route.args), opts);
    case 'auditFix':
      return planAuditFix(config, { ...facts, pm: route.pm }, pmAuditFixArgv(route.pm, route.fixToken, route.args), opts);
    case 'audit':
      return planAudit(config, facts, route.argv, opts);
    case 'auditSignatures':
      return planAuditSignatures(config, { ...facts, pm: route.pm }, pmAuditSignaturesArgv(route.pm, route.args), opts);
    case 'run': {
      // `sandbox x` / `sandbox npx` / `pnpm dlx` can FETCH a package as a fallback, so the runner
      // wants the install-class network defaults (registry-only allowlist), not the generic run
      // default of network:none. Local bins still work fine through the same path.
      if (execPackageTargets(route.argv).length) {
        const runnerCfg = { ...config, run: { ...config.run, network: config.install.network, devPorts: false, ports: [] } };
        return planRun(runnerCfg, facts, route.argv, opts);
      }
      return planRun(config, facts, route.argv, opts);
    }
  }
}

/** Redact every non-essential env value before a `--json` plan dump, so secrets never reach stdout. */
function redactPlanEnv(plan: RunPlan): RunPlan {
  return {
    ...plan,
    env: Object.fromEntries(Object.entries(plan.env).map(([key, value]) => [key, JSON_SAFE_ENV.has(key) ? value : '[redacted]'])),
  };
}

/**
 * After a contained run throws (usually a cryptic "failed to build" plus a raw daemon error), work out
 * whether the real cause is the container runtime being missing or its daemon being down, and return
 * the same friendly guidance `doctor`/`setup` give. Undefined when the backend looks healthy, so an
 * unrelated error surfaces unchanged. Probes only on the failure path, so a healthy run pays nothing.
 */
async function explainBackendDown(bin: string, backend: 'docker' | 'podman'): Promise<string[] | undefined> {
  const installed = (await quiet(bin, ['--version'])) === 0;
  const daemonUp = installed && (await quiet(bin, ['info'])) === 0;
  return backendDownGuidance({ installed, daemonUp }, backend);
}

/**
 * Run a tree-mutating install natively on the host (no container). The gate engine already vetted the
 * route; a native install runs lifecycle scripts on the host, so this is the heuristic-gates path, not
 * the container boundary. Mirrors the contained path's --dry-run/--json contract.
 */
function runNativeInstall(argv: string[], cwd: string, globals: Globals, action: string): number {
  if (globals.dryRun) {
    console.log(`sandbox: would install natively on the host, no container:\n  ${argv.join(' ')}`);
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
 * Shared post-install build-approval resolution, used by BOTH the native and contained write paths
 * (pnpm refuses unknown dependency build scripts and records them under `allowBuilds:` in
 * pnpm-workspace.yaml as undecided). Resolve it the same way everywhere so the everyday native default
 * keeps the approval UX: `--allow-all-builds`, an interactive prompt, or the one-line guidance, then a
 * re-run. Keys off the pm in `argv` (not the repo's detected one), so `sandbox npm install` in a pnpm
 * repo doesn't trip pnpm's state. `contained` only adjusts the honesty of the copy. Returns 'rerun'
 * (approvals written, install again), { block } (unresolved, surface non-zero), or 'ok' (nothing pending).
 */
async function resolveBuildApprovals(ctx: WriteContext, argv: string[], installCode: number, contained: boolean): Promise<'rerun' | { block: number } | 'ok'> {
  const isPnpmInstall = argvRunsPnpm(argv) && classifyCommand(argv) !== 'other';
  const pending = isPnpmInstall ? findPendingBuilds(ctx.project.rootDir) : [];
  const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !ctx.globals.json && !ctx.globals.dryRun;
  const decision = planBuildApproval({ pendingCount: pending.length, isPnpmInstall, allowAll: ctx.globals.allowAllBuilds, canPrompt });
  const where = contained ? 'contained in the sandbox' : 'on the host';
  switch (decision) {
    case 'none':
      return 'ok';
    case 'approve-all': {
      const r = writeBuildApprovals(ctx.project.rootDir, new Map(pending.map((n) => [n, true])));
      log.info(`approved build scripts (${where}): ${r.allowed.join(', ')}; re-running install`);
      return 'rerun';
    }
    case 'prompt': {
      const decisions = await promptBuildApprovals(pending, contained);
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
 * Run a plan inside the throwaway container, with the post-install build-approval loop and the
 * blocked-egress retry/allow prompt. --dry-run/--json describe the plan and return.
 */
async function runContained(ctx: WriteContext, initialPlan: RunPlan): Promise<number> {
  const { globals, config, project, backend } = ctx;
  let plan = initialPlan;
  if (globals.dryRun) {
    console.log(renderPlanSummary(plan));
    return 0;
  }
  if (globals.json) {
    console.log(JSON.stringify(redactPlanEnv(plan), null, 2));
    return 0;
  }
  const canPrompt = canPromptInteractively(globals.interactive);
  if (globals.interactive && !canPrompt) log.info('--interactive requested, but no TTY is attached, continuing non-interactively');
  // The project's own registry hosts (from .npmrc) so the prompt can label them as expected.
  const registryHosts = projectRegistryHints(project.rootDir).hosts;
  // Canaries only do anything where there's an egress proxy log to watch (allowlist mode); plant
  // them once and reuse across retries so the same honeytokens persist if we widen + re-run.
  const wantCanaries = globals.canaries ?? config.install.canaries;
  const canary = wantCanaries && networkPolicy(plan.network).useEgressProxy ? makeCanary() : undefined;
  if (wantCanaries && !canary) log.info(`canaries requested but inactive here, they need allowlist egress (the proxy that watches for leaked tokens); this phase runs network '${plan.network}'`);
  let buildApprovalTries = 0;
  for (;;) {
    let result: ExecuteResult;
    try {
      result = await execute(plan, backend, { failOnEgress: globals.failOnEgress, failOnSourceWrites: globals.failOnSourceWrites || config.install.failOnSourceWrites, ...(canary ? { canary } : {}) });
    } catch (e) {
      // Turn a cryptic build/run failure into the friendly "is Docker running?" guidance when that's
      // the real cause; otherwise let the original error surface.
      const hint = await explainBackendDown(backend.bin, globals.backend);
      if (!hint) throw e;
      const [problem, ...fixes] = hint;
      log.error(problem!); // the cause carries the ✖
      for (const line of fixes) log.info(line); // calm guidance, no alarm glyph
      return 1;
    }
    // Resolve pnpm's undecided build scripts through the shared post-install path (contained copy),
    // then re-run so the approved scripts actually build. Capped at 3 tries so a misbehaving tree
    // can't loop forever.
    if (buildApprovalTries < 3) {
      const ba = await resolveBuildApprovals(ctx, plan.argv, result.code, true);
      if (ba === 'rerun') {
        buildApprovalTries++;
        continue;
      }
      if (typeof ba === 'object') return ba.block;
    }
    if (!result.deniedHosts.length || !canPrompt) {
      // One calm, confident close after a clean dependency op: make the invisible protection legible
      // once. Only for install-class commands that succeeded — a dev server or a failed run says its
      // own thing. `classifyCommand` returns 'other' for run/scripts, so those stay quiet.
      const successNote = containedSuccessLine(result.code, plan.argv);
      if (successNote) log.info(successNote);
      return result.code;
    }
    const deniedHosts = [...new Set(result.deniedHosts)].sort();
    const choice = await promptForBlockedEgress(deniedHosts, { registryHosts });
    if (choice === 'cancel') return 1;
    if (choice === 'allow-project') {
      const r = allowHosts(project.rootDir, deniedHosts, project.configPath);
      log.info(`saved ${(r.added.length ? r.added : deniedHosts).join(', ')} to ${path.basename(r.file)} (team); retrying`);
    } else if (choice === 'allow-local') {
      const r = allowHostsLocal(project.rootDir, deniedHosts, project.configPath);
      log.info(`saved ${(r.added.length ? r.added : deniedHosts).join(', ')} to ${path.basename(r.file)} (personal, git-ignored); retrying`);
    }
    const retry = nextPlanForBlockedEgressChoice(plan, deniedHosts, choice);
    if (!retry) return result.code;
    plan = retry;
  }
}

/**
 * Native install with the same build-approval UX as the contained path: run on the host, then resolve
 * pnpm's undecided build scripts (host copy) and re-run. Honours `--frozen` (lockfile invariant +
 * reproducible argv). --dry-run/--json describe and return without an approval loop (nothing installed).
 */
async function runNativeWrite(ctx: WriteContext, route: Route, action: string): Promise<number> {
  const frozen = resolvedFrozen(route, ctx.opts, ctx.config);
  if (route.model === 'install') requireLockfileForFrozen({ ...ctx.facts, pm: route.pm }, frozen);
  const argv = routeToHostArgv(route, { frozen, yarnBerry: ctx.facts.isYarnBerry });
  let code = runNativeInstall(argv, ctx.facts.cwd, ctx.globals, action);
  if (ctx.globals.dryRun || ctx.globals.json) return code;
  for (let tries = 0; tries < 3; tries++) {
    const ba = await resolveBuildApprovals(ctx, argv, code, false);
    if (ba === 'rerun') {
      code = runNativeInstall(argv, ctx.facts.cwd, ctx.globals, ''); // action printed once, above
      continue;
    }
    if (typeof ba === 'object') return ba.block;
    return code; // 'ok'
  }
  return code;
}

/**
 * The single write entry point, shared by `sandbox install`/`add`/`update`/`remove`, the per-PM bins,
 * `approve-builds` (its re-install), and `upgrade --write`. A tree-mutating route follows the project's
 * one mode: a container-built tree stays contained, a host-native or fresh tree installs natively. The
 * explicit `sandbox <pm>` form forces the container. Read-only routes (run/audit) carry no tree, so they
 * just run contained. One place owns the native-vs-container decision, so every write surface agrees.
 */
export async function runWrite(ctx: WriteContext, route: Route): Promise<number> {
  const { config, facts, opts, globals, cmd, binLeader } = ctx;
  const writePm = modeAwareWritePm(route);
  if (!writePm) return runContained(ctx, planForRoute(route, config, facts, opts));
  const forceContainer = binLeader === undefined && isPackageManagerName(cmd);
  const host = hostPlatform();
  const mode = detectProjectMode(facts.cwd, host);
  const target = chooseInstallTarget(mode, forceContainer);
  // One action line before any write: the operation and where it runs, the pm, the mode, the one plain
  // why. Native states the honest no-boundary line; container names what the boundary buys.
  const action = writeActionLine({ verb: writeVerb(route), pm: writePm, mode, target });
  if (target === 'native') return runNativeWrite(ctx, route, action);
  // Container target. Skip narration on --json/--dry-run (runContained describes the plan there instead).
  if (!globals.json && !globals.dryRun) {
    log.info(action);
    // Louder, only when it matters: a forced contained install rebuilds a host-native node_modules as a
    // Linux tree the host IDE can't load. Only reached when the user forced the container over a
    // host-native tree (mode-aware would have gone native), so warn and, on a TTY, confirm.
    if (mode === 'host-native') {
      const warning = crossModeWarning({ hostOs: host.os, hostNativeCount: () => 1, pm: writePm });
      if (warning) {
        log.warn(warning);
        if (process.stdin.isTTY && process.stdout.isTTY) {
          const ok = await confirm({ message: 'Switch this project to container-built node_modules now?' });
          if (isCancel(ok) || !ok) {
            log.info('Kept this project on host-native deps. Nothing was installed. Drop the explicit `sandbox <pm>` to let sandbox install natively, or run your own package manager.');
            return 0;
          }
        }
      }
    }
  }
  return runContained(ctx, planForRoute(route, config, facts, opts));
}
