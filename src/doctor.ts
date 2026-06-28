import { existsSync } from 'node:fs';
import path from 'node:path';
import { readConfig, type SandboxConfig } from './config.js';
import { findHostIncompatiblePackagesInWorkspace, hostPlatform } from './native-deps.js';
import { lockfileName, lockfilePresent, resolvePackageManager } from './package-manager.js';
import { registryDiagnostics, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { nodeEolStatus } from './runtime-cve.js';

export interface DoctorOptions {
  config?: string;
  invocationCwd?: string;
  runWorkdir?: string;
}

export interface Check {
  level: 'ok' | 'fail' | 'info';
  label: string;
  detail: string;
  fixes?: string[];
}

function print(check: Check): void {
  console.log(`[${check.level}] ${check.label}: ${check.detail}`);
  for (const fix of check.fixes ?? []) console.log(`  fix: ${fix}`);
}

/** Exit code rule: doctor fails only on a real problem (a `fail`-level check), never on `info`. */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/**
 * The one-line verdict printed under the per-check report — the "am I good to go?" answer at a glance.
 * Failures point back at the report; an all-clear run names the next command. Pure so the wording is testable.
 */
export function doctorSummary(checks: Check[]): string {
  const failures = checks.filter((c) => c.level === 'fail').length;
  if (failures > 0) return `[fail] ${failures} ${failures === 1 ? 'check needs' : 'checks need'} attention, fix the above, then rerun: screen doctor`;
  return "[ok] all clear, you're ready: `screen install`";
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
    fixes: hasLockfile ? undefined : [`run \`screen install\` to create ${lockfile}`],
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
    checks.push({
      level: 'info',
      label: 'policy',
      detail: `install=${config.install.network}${config.install.frozen ? ', frozen' : ''}`,
    });
  }

  // The host Node line installs and lifecycle scripts run on. An EOL line means scripts execute on a
  // runtime that no longer receives security fixes.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (Number.isInteger(nodeMajor)) {
    const eol = nodeEolStatus(nodeMajor);
    if (eol.status === 'eol') {
      checks.push({ level: 'info', label: 'node runtime', detail: `host runs Node ${nodeMajor}, which reached end-of-life on ${eol.eol} (no more security fixes)`, fixes: ['upgrade to a maintained Node line'] });
    } else if (eol.status === 'active') {
      checks.push({ level: 'ok', label: 'node runtime', detail: `Node ${nodeMajor} (maintained until ${eol.eol})` });
    }
  }

  // node_modules platform consistency: a tree built inside a container carries Linux-only native deps
  // that host tooling (vitest/esbuild) can't load. Surface it so doctor explains the mismatch.
  if (existsSync(path.join(cwd, 'node_modules'))) {
    const foreignNative = findHostIncompatiblePackagesInWorkspace(cwd, hostPlatform());
    checks.push(
      foreignNative.length
        ? {
            level: 'info',
            label: 'node_modules',
            detail: `${foreignNative.length} package(s) are built for a Linux container, not this ${process.platform} host (e.g. ${foreignNative[0]}). Rebuild a host-native tree with a plain install.`,
            fixes: ['run a plain host install (e.g. `screen install`) to rebuild a host-native tree'],
          }
        : { level: 'ok', label: 'node_modules', detail: `native packages match this ${process.platform} host` },
    );
  }

  for (const check of checks) print(check);
  console.log('');
  console.log(doctorSummary(checks));

  return doctorExitCode(checks);
}
