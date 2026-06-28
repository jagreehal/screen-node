import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectImportCycles } from '../src/repo-checks/import-cycles.js';
import { evaluateInstallPolicy, parsePnpmWorkspacePolicy } from '../src/repo-checks/install-policy.js';
import { evaluateManifestPolicy } from '../src/repo-checks/manifest.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

describe('parsePnpmWorkspacePolicy', () => {
  it('parses allowBuilds and release-age settings', () => {
    const policy = parsePnpmWorkspacePolicy(`
allowBuilds:
  esbuild: true
  vite: false
minimumReleaseAge: 4320
minimumReleaseAgeExclude:
  - '@clack/prompts@1.5.1'
`);

    expect(policy.allowBuilds.get('esbuild')).toBe(true);
    expect(policy.allowBuilds.get('vite')).toBe(false);
    expect(policy.minimumReleaseAge).toBe(4320);
    expect(policy.minimumReleaseAgeExclude).toEqual(['@clack/prompts@1.5.1']);
  });

  it('tolerates indentation changes and nested policy keys', () => {
    const policy = parsePnpmWorkspacePolicy(`
packages:
    - apps/*
policy:
    allowBuilds:
        esbuild: true
    minimumReleaseAge: 4320
    minimumReleaseAgeExclude:
        - '@clack/prompts@1.5.1'
`);

    expect(policy.allowBuilds.get('esbuild')).toBe(true);
    expect(policy.minimumReleaseAge).toBe(4320);
    expect(policy.minimumReleaseAgeExclude).toEqual(['@clack/prompts@1.5.1']);
  });
});

describe('evaluateInstallPolicy', () => {
  it('accepts a policy with release-age protection and at least one explicit allowlist entry', () => {
    const policy = parsePnpmWorkspacePolicy(`
allowBuilds:
  esbuild: true
minimumReleaseAge: 4320
minimumReleaseAgeExclude:
  - '@clack/prompts@1.5.1'
`);

    expect(evaluateInstallPolicy(policy)).toEqual([]);
  });

  it('flags a weakened release-age policy', () => {
    const policy = parsePnpmWorkspacePolicy(`
allowBuilds:
  esbuild: true
minimumReleaseAge: 60
`);

    expect(evaluateInstallPolicy(policy)).toContain('pnpm minimumReleaseAge must be at least 4320 minutes');
  });

  it('flags a missing explicit build allowlist', () => {
    const policy = parsePnpmWorkspacePolicy(`
minimumReleaseAge: 4320
`);

    expect(evaluateInstallPolicy(policy)).toContain('pnpm allowBuilds must explicitly allow at least one trusted package');
  });
});

describe('detectImportCycles', () => {
  it('returns no cycles for an acyclic local graph', () => {
    const dir = tempDir('sbx-graph-ok-');
    writeFiles(dir, {
      'src/index.ts': "export * from './config.js';\n",
      'src/config.ts': "import './shared.js';\nexport const config = true;\n",
      'src/shared.ts': 'export const shared = true;\n',
    });

    expect(detectImportCycles(dir)).toEqual([]);
  });

  it('detects local cycles with repo-relative paths', () => {
    const dir = tempDir('sbx-graph-cycle-');
    writeFiles(dir, {
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': "export * from './c.js';\n",
      'src/c.ts': "import './a.js';\n",
    });

    expect(detectImportCycles(dir)).toEqual([
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'],
    ]);
  });

  it('ignores commented-out imports and string literals that look like imports', () => {
    const dir = tempDir('sbx-graph-false-positive-');
    writeFiles(dir, {
      'src/a.ts': [
        "// import './b.js';",
        'const comment = "import \'./b.js\'";',
        'export const a = true;',
        '',
      ].join('\n'),
      'src/b.ts': "import './a.js';\n",
    });

    expect(detectImportCycles(dir)).toEqual([]);
  });
});

describe('evaluateManifestPolicy', () => {
  it('accepts the expected manifest invariants', () => {
    expect(
      evaluateManifestPolicy({
        packageManager: 'pnpm@11.5.1',
        publishConfig: { access: 'public', provenance: true },
      }),
    ).toEqual([]);
  });

  it('flags drift in the manifest policy invariants', () => {
    expect(
      evaluateManifestPolicy({
        packageManager: 'npm@10.0.0',
        publishConfig: { access: 'public', provenance: false },
      }),
    ).toEqual([
      'package.json packageManager must stay pinned to pnpm@11.5.1',
      'package.json publishConfig must keep public access and provenance enabled',
    ]);
  });
});
