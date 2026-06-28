import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { createBackend, type ContainerBackend, type RunOverride } from './backend.js';
import { scanCanaryLog, type Canary } from './canary.js';
import { log } from './log.js';
import { findHostIncompatiblePackagesInWorkspace, hostPlatform } from './native-deps.js';
import { networkPolicy } from './network.js';
import type { RunPlan } from './plan.js';
import { endpointsFor, hostPortOf, isHostPortFree, resolvePortPublish } from './ports.js';
import { appendAudit } from './receipt.js';
import { missingAllowHosts, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { classifyCommand, snapshotTree, sourceWriteExit, summarizeUnexpectedChanges, wroteProjectLocalPnpmStore } from './tamper.js';

/**
 * Named volume blockers can leave empty host directories behind once the container exits.
 * Remove only the empty mountpoints so the host workspace returns to its pre-run shape.
 */
function cleanupBlockerMountpoints(plan: RunPlan): void {
  const root = plan.mounts.find((m) => m.type === 'bind' && m.target === '/workspace')?.source;
  if (!root) return;
  for (const m of plan.mounts) {
    if (m.type !== 'volume' || !m.target.startsWith('/workspace/')) continue;
    const hostPath = path.join(root, m.target.slice('/workspace/'.length));
    try {
      if (existsSync(hostPath) && readdirSync(hostPath).length === 0) rmdirSync(hostPath);
    } catch {
      /* best-effort: leave it if non-empty or unremovable */
    }
  }
}

export interface ExecuteOptions {
  failOnEgress?: boolean;
  /** Tripwire: fail an otherwise-clean install that wrote to the source tree (outside dependencies). */
  failOnSourceWrites?: boolean;
  canary?: Canary;
  /** Capture output across both proxied and isolated execution paths for CLI JSON/reporting flows. */
  capture?: boolean;
}

export interface ExecuteResult {
  code: number;
  deniedHosts: string[];
  canaryHits: string[];
  /** Project files the install changed outside dependency output (the writable-tree residual, made visible). */
  sourceWrites: string[];
  stdout?: string;
  stderr?: string;
}

/**
 * Audit logging is intentionally best-effort. A broken receipt sink must never block or alter the sandboxed run.
 */
function auditRun(plan: RunPlan, result: ExecuteResult): ExecuteResult {
  const file = process.env.SANDBOX_AUDIT_LOG;
  if (file) {
    try {
      // Worst-news-first event name: a canary or denied egress outranks a source write, which outranks a plain run.
      const event = result.canaryHits.length ? 'canary.exfil' : result.deniedHosts.length ? 'egress.denied' : result.sourceWrites.length ? 'install.source-write' : 'run';
      appendAudit(
        file,
        event,
        {
          argv: plan.argv.join(' '),
          code: result.code,
          ...(result.deniedHosts.length ? { deniedHosts: result.deniedHosts } : {}),
          ...(result.canaryHits.length ? { canaryHits: result.canaryHits } : {}),
          ...(result.sourceWrites.length ? { sourceWrites: result.sourceWrites.slice(0, 50) } : {}),
        },
        { now: new Date() },
      );
    } catch {
      /* best-effort: never let audit logging break the run */
    }
  }
  return result;
}

/**
 * Probe the configured ports, report the reachable URLs (and any skipped because their host
 * port is taken), and return the specs we can actually publish.
 */
async function resolvePublishablePorts(ports: string[]): Promise<string[]> {
  const { available, busy, conflicts } = await resolvePortPublish(ports, isHostPortFree);
  // One port → hand over the exact clickable URL. Many ports → that's the dev-port catch-all where
  // only one will actually serve, so listing five "open me" URLs misleads; name the mapped ports
  // and point at the URL the dev server announces itself. URLs/ports live in the message, not a
  // structured field (a redundant per-port object dump just bloats the line).
  if (available.length === 1) {
    log.info(`port forwarded → ${endpointsFor(available)[0]!.url}`);
  } else if (available.length > 1) {
    log.info(`dev ports forwarded to localhost: ${available.map(hostPortOf).join(', ')}; open the URL your dev server prints below`);
  }
  if (busy.length) {
    log.warn(`host port ${busy.map(hostPortOf).join(', ')} already in use; skipped (set run.ports to map a different one)`);
  }
  if (conflicts.length) {
    log.warn(`duplicate host port ignored: ${conflicts.map(hostPortOf).join(', ')}; each host port maps once (check run.ports / devPorts overlap)`);
  }
  return available;
}

export async function execute(
  plan: RunPlan,
  backend: ContainerBackend = createBackend('docker'),
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const workspaceRoot = plan.mounts.find((m) => m.type === 'bind' && m.target === '/workspace')?.source;
  const kind = classifyCommand(plan.argv);
  const before = workspaceRoot && kind !== 'other' ? snapshotTree(workspaceRoot) : undefined;
  await backend.ensureImage(plan.build);
  // `--mount type=bind` errors on a missing source, where `-v` would have created it. Recreate
  // that implicit behaviour for the mounts that opted in (the project Claude config dir).
  for (const m of plan.mounts) {
    if (m.ensureSource && m.source && !existsSync(m.source)) mkdirSync(m.source, { recursive: true });
  }
  const policy = networkPolicy(plan.network);
  // Publish only the host ports that are actually free. Probing first turns a fatal
  // "Bind for 0.0.0.0:8080 failed: port is already allocated" into a skipped line, and
  // because every spec is an explicit HOST:CONTAINER the URLs we print are the real ones.
  // The result rides the RunOverride seam (not a plan mutation) so the plan stays immutable.
  const publishPorts = plan.interactive && plan.ports.length ? await resolvePublishablePorts(plan.ports) : plan.ports;
  const realize = (override: RunOverride): Promise<{ code: number; stdout?: string; stderr?: string }> => {
    const o = { ...override, ports: publishPorts };
    return opts.capture ? backend.runPlanCaptured(plan, o) : backend.runPlan(plan, o).then((code) => ({ code }));
  };
  const captured = (out: { stdout?: string; stderr?: string }) => (opts.capture ? { stdout: out.stdout ?? '', stderr: out.stderr ?? '' } : {});

  // Run the command in the container and collect egress/canary evidence into an ExecuteResult. Two
  // shapes: the default-deny egress-proxy path (allowlist + optional canary scan) and the plain
  // isolated/full-network path. Returns rather than assigns so the result is a single immutable value
  // in this security-critical path (no half-built `raw` to reason about). sourceWrites is filled in
  // by the post-run inspection below, which must run AFTER cleanup, so it starts empty here.
  const runContained = async (): Promise<ExecuteResult> => {
    if (policy.useEgressProxy) {
      const denied: string[] = [];
      const canaryHits: string[] = [];
      const out = await backend.withEgress(
        plan.egressAllow,
        ({ network, proxyEnv }) => realize({ network, extraEnv: { ...proxyEnv, ...opts.canary?.env } }),
        (hosts) => denied.push(...hosts),
        opts.canary ? (logText) => canaryHits.push(...scanCanaryLog(logText, opts.canary!).map((h) => h.line)) : undefined,
      );
      if (canaryHits.length) {
        log.error('CANARY TRIPPED, a planted honeytoken credential left the sandbox; treat this as a live exfiltration attempt', { lines: canaryHits.slice(0, 5) });
      }
      if (denied.length && !opts.capture) {
        log.warn(`install paused because sandbox blocked ${denied.length} network request(s) to host(s) outside your egress allowlist`, { hosts: denied });
        const add = missingAllowHosts(plan.egressAllow, denied);
        if (add.length) {
          log.info(`Why this happened: the install tried to reach a host that is not allowed yet. A common case is fetching native build headers from nodejs.org.`);
          log.info(`Allow ${add.length === 1 ? 'it' : 'them'} for this repo: ${renderAllowCommand(add)}`);
          log.info(`Config preview:\n${renderAllowlistSnippet(plan.egressAllow, add)}`);
          log.info('Retry once with full network: re-run with --full-network');
        }
      }
      // failOnEgress turns a denied request into a failed run; canary evidence (proof of exfiltration) always does.
      const egressFail = opts.failOnEgress && denied.length;
      const code = (egressFail || canaryHits.length) && out.code === 0 ? 1 : out.code;
      return { code, deniedHosts: denied, canaryHits, sourceWrites: [], ...captured(out) };
    }
    const network = policy.isolate ? 'none' : undefined;
    const out = await realize({ network });
    return { code: out.code, deniedHosts: [], canaryHits: [], sourceWrites: [], ...captured(out) };
  };

  // Always clean up blocker mountpoints once the run settles (success or throw); the source-tree
  // inspection below runs only on a completed run, after cleanup, never on the throw path.
  const raw = await runContained().finally(() => cleanupBlockerMountpoints(plan));

  // Post-run inspection of the writable source tree. The install ran in a tree we keep writable by
  // design (README: "your source tree stays writable"), so a malicious script CAN edit src/. We can't
  // prevent that after the fact, but we make it visible: surface the change, record it as a first-class
  // audit event, and (when armed) fail the run as a tripwire so CI / an agent notices and reverts.
  let sourceWrites: string[] = [];
  if (workspaceRoot && before && kind !== 'other') {
    const after = snapshotTree(workspaceRoot);
    sourceWrites = summarizeUnexpectedChanges(before, after, kind);
    if (sourceWrites.length) {
      log.warn(`install changed ${sourceWrites.length} project file(s) outside dependency output paths`, {
        files: sourceWrites.slice(0, 8),
        truncated: sourceWrites.length > 8,
      });
    }
    if (wroteProjectLocalPnpmStore(before, after)) {
      log.info('pnpm created a project-local store (.pnpm-store/). Keep using `sandbox` commands to reuse it. A later host `pnpm install` rebuilds node_modules against the host store.');
    }
    // The install ran on Linux, so native optional deps resolve for that platform and can't load
    // on a macOS/Windows host. This is expected (not a problem) — one calm line with the options, so it
    // lands before the host's own toolchain (vite/vitest/tsx) fails with a cryptic missing module.
    const foreignNative = findHostIncompatiblePackagesInWorkspace(workspaceRoot, hostPlatform());
    if (foreignNative.length) {
      log.info(
        `This project now has ${foreignNative.length} native package(s) built for the Linux container, not your ${process.platform} host. Run project tools in the container: \`sandbox test\`, \`sandbox dev\`. Rebuild for your host IDE: run a plain host install. Keep the whole session inside the container: \`sandbox devcontainer init\`.`,
        { packages: foreignNative.slice(0, 8), truncated: foreignNative.length > 8 },
      );
    }
  }
  const code = sourceWriteExit(raw.code, sourceWrites.length, opts.failOnSourceWrites ?? false);
  if (code !== raw.code) {
    log.error('This install modified files in your source tree outside dependencies, so the source-write tripwire failed the run. Review the changes with `git diff`. Revert them if needed. Or rerun without --fail-on-source-writes to allow this.');
  }
  return auditRun(plan, { ...raw, code, sourceWrites });
}
