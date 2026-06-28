import { SandboxConfigSchema } from '../src/config.js';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowHosts, allowHostsLocal, detectEgressHosts, detectRegistryHints, missingAllowHosts, registryDiagnostics, renderAllowCommand, renderAllowlistSnippet } from '../src/registry.js';

describe('detectRegistryHints', () => {
  it('finds registry hosts and auth env refs from .npmrc text', () => {
    const hints = detectRegistryHints(`
registry=https://registry.npmjs.org/
@acme:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}
//registry.npmjs.org/:_authToken=\${NPM_TOKEN}
`);
    expect(hints).toEqual({
      hosts: ['npm.pkg.github.com', 'registry.npmjs.org'],
      authEnvNames: ['GITHUB_TOKEN', 'NPM_TOKEN'],
    });
  });
});

describe('allowlist helpers', () => {
  it('returns only hosts not already allowed', () => {
    expect(missingAllowHosts(['npmjs.org', 'npmjs.com'], ['npmjs.org', 'npm.pkg.github.com'])).toEqual(['npm.pkg.github.com']);
  });

  it('renders a copy-paste config snippet', () => {
    expect(renderAllowlistSnippet(['npmjs.org', 'npmjs.com'], ['npm.pkg.github.com'])).toBe(
      JSON.stringify({ egress: { allow: ['npm.pkg.github.com', 'npmjs.com', 'npmjs.org'] } }, null, 2),
    );
  });

  it('renders a screen allow command', () => {
    expect(renderAllowCommand(['nodejs.org', 'npm.pkg.github.com'])).toBe('screen allow nodejs.org npm.pkg.github.com');
  });

  it('adds hosts to egress.allow and writes the config back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-'));
    writeFileSync(path.join(dir, 'screen.config.json'), '{}');
    const result = allowHosts(dir, ['nodejs.org', 'https://npm.pkg.github.com/path']);
    expect(result.added).toEqual(['nodejs.org', 'npm.pkg.github.com']);
    expect(JSON.parse(readFileSync(path.join(dir, 'screen.config.json'), 'utf8')).egress.allow).toEqual([
      'nodejs.org',
      'npm.pkg.github.com',
      'npmjs.com',
      'npmjs.org',
    ]);
  });

  it('normalizes scheme-relative and host:port forms to bare hosts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-'));
    writeFileSync(path.join(dir, 'screen.config.json'), '{"egress":{"allow":[]}}');
    const result = allowHosts(dir, ['//registry.npmjs.org/:_authToken', 'registry.local:4873/path', '   ']);
    expect(result.added).toEqual(['registry.local:4873', 'registry.npmjs.org']);
  });

  it('allowHostsLocal writes a minimal personal override, not the whole team allowlist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-local-'));
    writeFileSync(path.join(dir, 'screen.config.json'), '{"egress":{"allow":["npmjs.org","npmjs.com","team-registry.local"]}}');
    const result = allowHostsLocal(dir, ['nodejs.org']);
    expect(result.file.endsWith('screen.config.local.json')).toBe(true);
    expect(result.added).toEqual(['nodejs.org']);
    // Only the personal host lands in the local file — team hosts are NOT duplicated here.
    expect(JSON.parse(readFileSync(result.file, 'utf8'))).toEqual({ egress: { allow: ['nodejs.org'] } });
  });

  it('allowHostsLocal preserves existing local fields and merges hosts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-local-'));
    writeFileSync(path.join(dir, 'screen.config.local.json'), '{"image":"custom:latest","egress":{"allow":["a.example.com"]}}');
    const result = allowHostsLocal(dir, ['b.example.com']);
    expect(JSON.parse(readFileSync(result.file, 'utf8'))).toEqual({ image: 'custom:latest', egress: { allow: ['a.example.com', 'b.example.com'] } });
  });

  it('allowHostsLocal writes the override next to the active --config file, not rootDir', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-local-cfg-'));
    const cfgDir = path.join(dir, 'configs');
    mkdirSync(cfgDir);
    const cfg = path.join(cfgDir, 'screen.config.json');
    writeFileSync(cfg, '{}');
    const result = allowHostsLocal(dir, ['nodejs.org'], cfg);
    expect(result.file).toBe(path.join(cfgDir, 'screen.config.local.json'));
  });

  it('allowHosts (team save) does NOT bake a personal local-layer override into the committed file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-team-'));
    writeFileSync(path.join(dir, 'screen.config.json'), JSON.stringify({ egress: { allow: ['team.example.com'] }, run: { network: 'none' } }));
    // A personal override that loosens the boundary and adds a personal host.
    writeFileSync(path.join(dir, 'screen.config.local.json'), JSON.stringify({ run: { network: 'on' }, egress: { allow: ['personal.example.com'] } }));
    allowHosts(dir, ['nodejs.org']);
    const written = JSON.parse(readFileSync(path.join(dir, 'screen.config.json'), 'utf8'));
    expect(written.run.network).toBe('none'); // the personal loosening is NOT committed
    expect(written.egress.allow).toContain('team.example.com');
    expect(written.egress.allow).toContain('nodejs.org');
    expect(written.egress.allow).not.toContain('personal.example.com'); // personal host stays personal
  });
});

describe('detectEgressHosts', () => {
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-egress-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    return dir;
  };

  it('pulls a private registry host from .npmrc', () => {
    const dir = fixture({
      '.npmrc': '@acme:registry=https://npm.pkg.github.com\n',
      'package.json': '{"name":"x"}',
    });
    expect(detectEgressHosts(dir)).toContain('npm.pkg.github.com');
  });

  it('adds github hosts when a dependency is a git/github spec', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', dependencies: { tool: 'github:owner/repo#main' } }),
    });
    const hosts = detectEgressHosts(dir);
    expect(hosts).toContain('github.com');
    expect(hosts).toContain('codeload.github.com');
  });

  it('returns nothing for a plain project with no .npmrc and registry deps', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', dependencies: { zod: '^3.0.0' } }) });
    expect(detectEgressHosts(dir)).toEqual([]);
  });

  it('pre-allows nodejs.org when a node-gyp/prebuild dependency is present', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', dependencies: { 'node-gyp-build': '^4.0.0' } }) });
    expect(detectEgressHosts(dir)).toContain('nodejs.org');
  });

  it('pre-allows nodejs.org when a binding.gyp is present (even without a gyp dependency)', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ name: 'x' }), 'binding.gyp': '{}' });
    expect(detectEgressHosts(dir)).toContain('nodejs.org');
  });

  it('does NOT pre-allow nodejs.org for a pure-JS project', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', dependencies: { zod: '^3.0.0' } }) });
    expect(detectEgressHosts(dir)).not.toContain('nodejs.org');
  });
});

describe('registryDiagnostics', () => {
  it('summarizes missing allowlist entries and registry auth gaps from .npmrc', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-regdiag-'));
    writeFileSync(
      path.join(dir, '.npmrc'),
      '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n',
    );
    const diag = registryDiagnostics(dir, SandboxConfigSchema.parse({}), {});
    expect(diag).toEqual({
      hints: {
        hosts: ['npm.pkg.github.com'],
        authEnvNames: ['GITHUB_TOKEN'],
      },
      missingAllowHosts: ['npm.pkg.github.com'],
      missingEnvGrants: ['GITHUB_TOKEN'],
      unsetHostEnv: ['GITHUB_TOKEN'],
    });
  });
});
