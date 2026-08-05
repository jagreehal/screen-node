import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NUB_PLUGIN_HELP, nubPluginCommand, nubPluginDecision } from '../src/nub-plugin.js';
import { projectLockfileName, resolvePackageManager } from '../src/package-manager.js';
import { readAllPackagesFromLockfile } from '../src/risk.js';

const originalNubPlugin = process.env.SCREEN_NUB_PLUGIN;

afterEach(() => {
  if (originalNubPlugin === undefined) delete process.env.SCREEN_NUB_PLUGIN;
  else process.env.SCREEN_NUB_PLUGIN = originalNubPlugin;
});

describe('nub plugin command boundary', () => {
  it('finds the command after screen global flags and their values', () => {
    expect(nubPluginCommand(['--json', '--config', 'team.json', '--risk', 'thorough', 'check', 'zod'])).toBe('check');
  });

  it('delegates complementary security commands to the screen CLI', () => {
    for (const command of ['check', 'scan', 'delta', 'secrets', 'doctor', 'verify', 'feeds', 'audit']) {
      expect(nubPluginDecision([command])).toEqual({ kind: 'delegate' });
    }
  });

  it('keeps package installation and execution in Nub', () => {
    for (const command of ['install', 'add', 'remove', 'update', 'upgrade', 'approve-builds', 'run', 'script', 'dev', 'x']) {
      const decision = nubPluginDecision([command]);
      expect(decision.kind, command).toBe('reject');
      if (decision.kind === 'reject') expect(decision.message).toContain('Nub owns');
    }
  });

  it('renders plugin-specific help instead of the package-manager wrapper help', () => {
    expect(nubPluginDecision([])).toEqual({ kind: 'help' });
    expect(nubPluginDecision(['help'])).toEqual({ kind: 'help' });
    expect(NUB_PLUGIN_HELP).toContain('nub screen check zod && nub add zod');
  });

  it('delegates version flags to the packaged screen CLI', () => {
    expect(nubPluginDecision(['--version'])).toEqual({ kind: 'delegate' });
    expect(nubPluginDecision(['-v'])).toEqual({ kind: 'delegate' });
  });

  it('ships the exact nub-screen executable name Nub resolves', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin['nub-screen']).toBe('./bin/nub-screen.mjs');
    expect(readFileSync(path.join(process.cwd(), pkg.bin['nub-screen']!), 'utf8')).toContain('nubPluginDecision');
  });

  it('reads Nub identity lock.yaml as pnpm v9 only inside the plugin boundary', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'nub-screen-lock-'));
    writeFileSync(path.join(cwd, 'lock.yaml'), `lockfileVersion: '9.0'
packages:
  zod@4.0.0:
    resolution: {integrity: sha512-test}
snapshots:
  zod@4.0.0: {}
`);

    delete process.env.SCREEN_NUB_PLUGIN;
    expect(resolvePackageManager(cwd)).toBe('npm');
    expect(projectLockfileName(cwd, 'pnpm')).toBe('pnpm-lock.yaml');

    process.env.SCREEN_NUB_PLUGIN = '1';
    expect(resolvePackageManager(cwd)).toBe('pnpm');
    expect(projectLockfileName(cwd, 'pnpm')).toBe('lock.yaml');
    expect(readAllPackagesFromLockfile(cwd, 'pnpm')).toContainEqual({ name: 'zod', version: '4.0.0' });
  });
});
