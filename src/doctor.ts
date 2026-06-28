import { existsSync } from 'node:fs';
import path from 'node:path';
import { createBackend, sandboxImageUpToDate } from './backend.js';
import { capture, quiet } from './exec.js';
import { readConfig, type SandboxConfig } from './config.js';
import { resolveBaseImage, resolveBuildSpec } from './image.js';
import { findHostIncompatiblePackagesInWorkspace, hostPlatform } from './native-deps.js';
import { lockfileName, lockfilePresent, resolvePackageManager } from './package-manager.js';
import { registryDiagnostics, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { nodeEolStatus, runtimeVulnerabilities } from './runtime-cve.js';

export interface DoctorOptions {
  config?: string;
  image?: string;
  backend: 'docker' | 'podman';
  invocationCwd?: string;
  runWorkdir?: string;
  /** Run the safe auto-fixes (currently: rebuild an absent/stale image) instead of only reporting. */
  fix?: boolean;
}

/** The fixes `doctor --fix` is allowed to run on its own — deliberately only the non-destructive ones. */
export type AutoFixAction = 'build';

export interface Check {
  level: 'ok' | 'fail' | 'info';
  label: string;
  detail: string;
  fixes?: string[];
  /** Set when this check's remedy is safe to run automatically under `--fix`. */
  autoFix?: AutoFixAction;
}

/**
 * The distinct auto-fix actions `--fix` should run for a set of checks. Pure so the policy (what is
 * and isn't safe to automate) is testable without a daemon. A down daemon or a missing config carry
 * `fixes` hints but no `autoFix`, so they're reported and never run blindly.
 */
export function autoFixActions(checks: Check[]): AutoFixAction[] {
  const seen = new Set<AutoFixAction>();
  for (const check of checks) if (check.autoFix) seen.add(check.autoFix);
  return [...seen];
}

function print(check: Check): void {
  console.log(`[${check.level}] ${check.label}: ${check.detail}`);
  for (const fix of check.fixes ?? []) console.log(`  fix: ${fix}`);
}

function installCommand(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'brew install --cask docker' : 'brew install podman';
  return backend === 'docker' ? 'install Docker and ensure `docker` is on PATH' : 'install Podman and ensure `podman` is on PATH';
}

function startCommand(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'open -a Docker' : 'podman machine start';
  return backend === 'docker' ? 'sudo systemctl start docker' : 'start the Podman service or machine for this host';
}

/** Exit code rule: doctor fails only on a real problem (a `fail`-level check), never on `info`. */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/**
 * The one-line verdict printed under the per-check report — the "am I good to go?" answer at a glance.
 * Failures point back at the report; an all-clear run names the next two commands so onboarding never
 * dead-ends on a wall of green checks. Pure so the wording is testable without a daemon.
 */
export function doctorSummary(checks: Check[]): string {
  const failures = checks.filter((c) => c.level === 'fail').length;
  if (failures > 0) return `[fail] ${failures} ${failures === 1 ? 'check needs' : 'checks need'} attention, fix the above, then rerun: sandbox doctor`;
  return "[ok] all clear, you're ready: `sandbox install`, then `sandbox dev`";
}

export async function runDoctor(cwd: string, opts: DoctorOptions): Promise<number> {
  const checks: Check[] = [];

  const configFile = opts.config ?? path.join(cwd, 'sandbox.config.json');
  let config: SandboxConfig | undefined;
  try {
    config = readConfig(cwd, opts.config);
    const present = existsSync(configFile);
    checks.push({
      level: present ? 'ok' : 'info',
      label: 'config',
      detail: present ? configFile : `no config file, using defaults (create ${configFile} to customise)`,
    });
  } catch (e) {
    checks.push({
      level: 'fail',
      label: 'config',
      detail: e instanceof Error ? e.message.replace(/^sandbox:\s*/, '') : String(e),
    });
  }

  const pm = resolvePackageManager(cwd);
  const lockfile = lockfileName(pm);
  const hasLockfile = lockfilePresent(cwd, pm);
  checks.push({
    level: hasLockfile ? 'ok' : 'info',
    label: 'package manager',
    detail: hasLockfile ? `${pm} (${lockfile})` : `${pm} (no ${lockfile} yet)`,
    fixes: hasLockfile ? undefined : [`run \`sandbox install\` to create ${lockfile}`],
  });
  if (opts.invocationCwd && opts.invocationCwd !== cwd) {
    checks.push({ level: 'info', label: 'workspace root', detail: cwd });
    if (opts.runWorkdir) checks.push({ level: 'info', label: 'package workdir', detail: opts.runWorkdir });
  }
  if (config) {
    const registry = registryDiagnostics(cwd, config);
    if (registry.hints.hosts.length) {
      checks.push({
        level: registry.missingAllowHosts.length ? 'info' : 'ok',
        label: 'registry hosts',
        detail: registry.missingAllowHosts.length
          ? `${registry.hints.hosts.join(', ')} (.npmrc; missing from egress.allow: ${registry.missingAllowHosts.join(', ')})`
          : `${registry.hints.hosts.join(', ')} (.npmrc; covered by egress.allow)`,
        fixes: registry.missingAllowHosts.length
          ? [renderAllowCommand(registry.missingAllowHosts), renderAllowlistSnippet(config.egress.allow, registry.missingAllowHosts)]
          : undefined,
      });
    }
    if (registry.hints.authEnvNames.length) {
      checks.push({
        level: registry.missingEnvGrants.length || registry.unsetHostEnv.length ? 'info' : 'ok',
        label: 'registry auth',
        detail: `${registry.hints.authEnvNames.join(', ')} referenced in .npmrc`,
        fixes: [
          ...(registry.missingEnvGrants.length ? [`add to config: ${JSON.stringify({ grants: { env: [...config.grants.env, ...registry.missingEnvGrants].sort() } })}`] : []),
          ...(registry.unsetHostEnv.length ? registry.unsetHostEnv.map((name) => `export ${name}=...`) : []),
        ],
      });
    }
  }

  const version = await capture(opts.backend, ['--version']);
  if (version.code !== 0) {
    checks.push({
      level: 'fail',
      label: 'backend',
      detail: version.stderr.trim() || version.stdout.trim() || `${opts.backend} not found`,
      fixes: [installCommand(opts.backend), 'rerun: sandbox doctor'],
    });
  } else {
    checks.push({
      level: 'ok',
      label: 'backend',
      detail: version.stdout.trim() || version.stderr.trim(),
    });

    const info = await capture(opts.backend, ['info']);
    if (info.code !== 0) {
      checks.push({
        level: 'fail',
        label: 'daemon',
        detail: info.stderr.trim() || info.stdout.trim() || `${opts.backend} info failed`,
        fixes: [startCommand(opts.backend), 'rerun: sandbox doctor'],
      });
    } else {
      checks.push({ level: 'ok', label: 'daemon', detail: 'reachable' });

      // A container-escape CVE in the runtime defeats every containment guarantee, so
      // flag a stale one. Prefer the runc version (often a commit hash in `info`, which
      // simply falls through); else use the Docker engine version. runc only for docker.
      const runcMatch = /runc version:\s*(\S+)/i.exec(info.stdout);
      const vulns = runtimeVulnerabilities({
        engine: opts.backend === 'docker' ? version.stdout : undefined,
        runc: runcMatch?.[1],
      });
      if (vulns.length) {
        for (const v of vulns) {
          checks.push({ level: 'info', label: 'runtime security', detail: `${v.name} (${v.id}): ${v.detail}`, fixes: [v.fix] });
        }
      } else {
        checks.push({ level: 'ok', label: 'runtime security', detail: 'no known container-escape CVE for the reported runtime' });
      }
    }

    if (config) {
      // Resolve to the tag a run will actually use (per-fingerprint for the managed image), so the
      // presence/staleness check inspects that image rather than a bare `:latest` that no longer exists.
      const spec = resolveBuildSpec(config, opts.image ?? config.image, cwd);
      const image = spec.tag;
      const present = (await quiet(opts.backend, ['image', 'inspect', image])) === 0;
      // "present" by tag isn't enough: a run rebuilds when the image's spec fingerprint no longer
      // matches the current config (changed base/extras/Dockerfile). Report that so doctor doesn't
      // say "present" right before the next run quietly rebuilds it.
      const upToDate = present && (await sandboxImageUpToDate(opts.backend, spec));
      checks.push({
        level: present && upToDate ? 'ok' : 'info',
        label: 'image',
        detail: !present
          ? `${image} will build on first use`
          : upToDate
            ? `${image} is present and matches the current config`
            : `${image} is present but out of date, the next run rebuilds it (config changed since it was built)`,
        fixes: present && upToDate ? undefined : [`run \`sandbox build\` to ${present ? 'rebuild' : 'build'} it now`],
        autoFix: present && upToDate ? undefined : 'build',
      });
      checks.push({
        level: 'info',
        label: 'policy',
        detail: `install=${config.install.network}${config.install.frozen ? ', frozen' : ''}; run=${config.run.network}`,
      });

      // The Node line the sandbox image runs on. An EOL line means lifecycle scripts execute on a
      // runtime that no longer receives security fixes. Only checked when the base is a numeric
      // `node:<major>` tag and the security layers still apply (a custom Dockerfile owns its own base).
      if (!config.build.customDockerfileUnsafe) {
        const nodeMajor = /node:(\d+)/.exec(resolveBaseImage(config.build))?.[1];
        if (nodeMajor) {
          const eol = nodeEolStatus(Number(nodeMajor));
          if (eol.status === 'eol') {
            checks.push({ level: 'info', label: 'node runtime', detail: `image uses Node ${nodeMajor}, which reached end-of-life on ${eol.eol} (no more security fixes)`, fixes: ['bump build.nodeVersion (or build.baseImage) to a maintained line, then `sandbox build`'] });
          } else if (eol.status === 'active') {
            checks.push({ level: 'ok', label: 'node runtime', detail: `Node ${nodeMajor} (maintained until ${eol.eol})` });
          }
        }
      }
    }
  }

  // node_modules platform consistency. A `sandbox` install runs in the container, so it writes the
  // container's native optional deps (e.g. `@rolldown/binding-linux-*`) into the host-mounted tree.
  // Host tooling (vitest/esbuild) then fails with a cryptic missing-binding error. Surface it here
  // with the same fix as the post-install note, so `doctor` explains the mismatch before a test run does.
  if (existsSync(path.join(cwd, 'node_modules'))) {
    const foreignNative = findHostIncompatiblePackagesInWorkspace(cwd, hostPlatform());
    checks.push(
      foreignNative.length
        ? {
            level: 'info',
            label: 'node_modules',
            detail: `${foreignNative.length} package(s) are built for the Linux container, not this ${process.platform} host (e.g. ${foreignNative[0]}). One mode per project: run project tools with \`sandbox test\`/\`sandbox dev\`, or rebuild a host-native tree with a plain install.`,
            fixes: [`run tests via \`sandbox test\`/\`sandbox dev\`, run a plain host install for a local (host-native) tree, or \`sandbox devcontainer init\` to run the editor in the container`],
          }
        : { level: 'ok', label: 'node_modules', detail: `native packages match this ${process.platform} host` },
    );
  }

  for (const check of checks) print(check);
  console.log('');
  console.log(doctorSummary(checks));

  if (opts.fix) {
    const actions = autoFixActions(checks);
    if (!actions.length) {
      console.log('[ok] fix: nothing to auto-fix');
    } else if (actions.includes('build') && config) {
      const image = opts.image ?? config.image;
      console.log(`[..] fix: building ${image} and the egress-proxy image`);
      const code = await createBackend(opts.backend).buildImages(resolveBuildSpec(config, image, cwd));
      if (code !== 0) {
        console.log('[fail] fix: image build failed');
        return 1;
      }
      console.log('[ok] fix: image rebuilt');
    }
  }

  return doctorExitCode(checks);
}
