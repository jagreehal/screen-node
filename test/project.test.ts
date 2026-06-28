import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '../src/config.js';
import { probeProject } from '../src/project.js';

const cfg = (over: object = {}) => SandboxConfigSchema.parse(over);

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-probe-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe('probeProject', () => {
  it('detects the package manager from the lockfile (npm fallback)', () => {
    expect(probeProject(project({ 'pnpm-lock.yaml': '' }), cfg()).pm).toBe('pnpm');
    expect(probeProject(project({ 'yarn.lock': '' }), cfg()).pm).toBe('yarn');
    expect(probeProject(project({ 'bun.lock': '' }), cfg()).pm).toBe('bun');
    expect(probeProject(project({ 'bun.lockb': '' }), cfg()).pm).toBe('bun'); // legacy binary lockfile
    expect(probeProject(project(), cfg()).pm).toBe('npm');
  });

  it('prefers package.json packageManager over lockfile heuristics', () => {
    expect(probeProject(project({
      'package.json': JSON.stringify({ packageManager: 'pnpm@11.5.1' }),
      'package-lock.json': '{}',
    }), cfg()).pm).toBe('pnpm');
    expect(probeProject(project({
      'package.json': JSON.stringify({ packageManager: 'npm@10.9.0' }),
      'pnpm-lock.yaml': '',
    }), cfg()).pm).toBe('npm');
  });

  it('reports lockfile presence for either bun lockfile spelling', () => {
    expect(probeProject(project({ 'bun.lockb': '' }), cfg()).hasLockfile).toBe(true);
  });

  it('reads package.json scripts ({} when absent or unreadable)', () => {
    expect(probeProject(project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', dev: 'vite' } }) }), cfg()).scripts).toEqual({ test: 'vitest', dev: 'vite' });
    expect(probeProject(project({ 'package.json': '{"name":"x"}' }), cfg()).scripts).toEqual({});
    expect(probeProject(project(), cfg()).scripts).toEqual({});
    expect(probeProject(project({ 'package.json': '{ not json' }), cfg()).scripts).toEqual({});
  });

  it('reports lockfile + manifest presence for the detected pm', () => {
    const facts = probeProject(project({ 'pnpm-lock.yaml': '', 'package.json': '{}' }), cfg());
    expect(facts.hasLockfile).toBe(true);
    expect(facts.hasPackageJson).toBe(true);
    expect(facts.directDependencies).toEqual([]);
    expect(probeProject(project(), cfg()).hasLockfile).toBe(false);
  });

  it('flags Yarn Berry from a .yarnrc.yml', () => {
    expect(probeProject(project({ 'yarn.lock': '', '.yarnrc.yml': '' }), cfg()).isYarnBerry).toBe(true);
    expect(probeProject(project({ 'yarn.lock': '' }), cfg()).isYarnBerry).toBe(false);
  });

  it('collects only the persistence paths that exist on disk', () => {
    const cwd = project();
    mkdirSync(path.join(cwd, '.github'));
    mkdirSync(path.join(cwd, '.husky'));
    const facts = probeProject(cwd, cfg());
    expect(facts.existingPersistencePaths).toEqual(expect.arrayContaining(['.github', '.husky']));
    expect(facts.existingPersistencePaths).not.toContain('.git');
  });

  it('records cwd and the host home directory', () => {
    const cwd = project();
    const facts = probeProject(cwd, cfg());
    expect(facts.cwd).toBe(cwd);
    expect(facts.homedir).toBe(homedir());
  });

  it('parses per-invocation env files against the invocation base dir', () => {
    const cwd = project();
    mkdirSync(path.join(cwd, 'apps', 'web'), { recursive: true });
    writeFileSync(path.join(cwd, 'apps', 'web', '.env.local'), 'API_URL=http://localhost:3000\nFEATURE_FLAG=true\n');
    const facts = probeProject(cwd, cfg(), { envFiles: ['.env.local'], envFileBaseDir: path.join(cwd, 'apps', 'web') });
    expect(facts.envFileValues.API_URL).toBe('http://localhost:3000');
    expect(facts.envFileValues.FEATURE_FLAG).toBe('true');
  });

  it('resolves config.grants.envFiles from the project root by default', () => {
    const cwd = project({ '.env': 'FROM_GRANT=1\n' });
    const facts = probeProject(cwd, cfg({ grants: { envFiles: ['.env'] } }));
    expect(facts.envFileValues.FROM_GRANT).toBe('1');
  });

  it('keeps config env files rooted at the project root even when invocation env files come from a leaf package', () => {
    const cwd = project({
      '.env': 'FROM_ROOT=1\nOVERRIDE=root\n',
      'apps/web/.env.local': 'FROM_LEAF=1\nOVERRIDE=leaf\n',
    });
    const facts = probeProject(cwd, cfg({ grants: { envFiles: ['.env'] } }), {
      envFiles: ['.env.local'],
      envFileBaseDir: path.join(cwd, 'apps', 'web'),
      configEnvFilesBaseDir: cwd,
    });
    expect(facts.envFileValues.FROM_ROOT).toBe('1');
    expect(facts.envFileValues.FROM_LEAF).toBe('1');
    expect(facts.envFileValues.OVERRIDE).toBe('leaf');
  });

  it('collects direct deps from package.json for risk checks', () => {
    const cwd = project({
      'package.json': JSON.stringify({
        dependencies: { zod: '^4.0.0' },
        devDependencies: { vitest: '^4.1.0' },
        optionalDependencies: { fsevents: '^2.3.3' },
      }),
    });
    const facts = probeProject(cwd, cfg());
    expect(facts.directDependencies).toEqual([
      { name: 'zod', spec: '^4.0.0' },
      { name: 'vitest', spec: '^4.1.0' },
      { name: 'fsevents', spec: '^2.3.3' },
    ]);
  });

  it('aggregates direct deps across workspace packages (package.json workspaces)', () => {
    const cwd = project({
      'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'], devDependencies: { turbo: '^2.0.0' } }),
      'apps/web/package.json': JSON.stringify({ dependencies: { next: '^15.0.0', '@me/db': 'workspace:*' } }),
      'packages/db/package.json': JSON.stringify({ dependencies: { mongodb: '^6.0.0' }, devDependencies: { '@types/mongodb': '^4.0.7' } }),
      'packages/.notapkg/readme.md': 'no package.json here', // dirs without a manifest are ignored
    });
    const names = probeProject(cwd, cfg()).directDependencies.map((d) => d.name).sort();
    // root + every workspace package, deduped — local workspace: specs are kept here (dropped later in riskTargetsForInstall)
    expect(names).toEqual(['@me/db', '@types/mongodb', 'mongodb', 'next', 'turbo']);
  });

  it('aggregates workspace packages from pnpm-workspace.yaml too', () => {
    const cwd = project({
      'package.json': JSON.stringify({ name: 'root', dependencies: { prettier: '^3.0.0' } }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
      'apps/web/package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'packages/ai/package.json': JSON.stringify({ dependencies: { zod: '^4.0.0' } }),
    });
    const names = probeProject(cwd, cfg()).directDependencies.map((d) => d.name).sort();
    expect(names).toEqual(['prettier', 'react', 'zod']);
  });
});
