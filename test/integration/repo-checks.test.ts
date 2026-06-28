import { describe, expect, it } from 'vitest';
import { fixture, runRepoScript } from './helpers.js';

describe('repo checks', () => {
  it('passes the import-cycle check for an acyclic fixture', async () => {
    const dir = fixture({
      'src/index.ts': "export * from './config.js';\n",
      'src/config.ts': "import './shared.js';\nexport const config = true;\n",
      'src/shared.ts': 'export const shared = true;\n',
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-import-cycles.ts');
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('fails the import-cycle check with a readable cycle path', async () => {
    const dir = fixture({
      'src/a.ts': "import './b.js';\n",
      'src/b.ts': "import './c.js';\n",
      'src/c.ts': "import './a.js';\n",
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-import-cycles.ts');
    expect(code).toBe(1);
    expect(stderr).toContain('import cycle: src/a.ts -> src/b.ts -> src/c.ts -> src/a.ts');
  });

  it('ignores commented and stringified pseudo-imports in the cycle check', async () => {
    const dir = fixture({
      'src/a.ts': [
        "// import './b.js';",
        'const sample = "import \'./b.js\'";',
        'export const a = true;',
        '',
      ].join('\n'),
      'src/b.ts': "import './a.js';\n",
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-import-cycles.ts');
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('passes the install-policy check for a tightly scoped pnpm policy', async () => {
    const dir = fixture({
      'pnpm-workspace.yaml': [
        'allowBuilds:',
        '  esbuild: true',
        'minimumReleaseAge: 4320',
        'minimumReleaseAgeExclude:',
        "  - '@clack/prompts@1.5.1'",
        '',
      ].join('\n'),
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-install-policy.ts');
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('accepts valid workspace policy after indentation changes', async () => {
    const dir = fixture({
      'pnpm-workspace.yaml': [
        'policy:',
        '    allowBuilds:',
        '        esbuild: true',
        '    minimumReleaseAge: 4320',
        '    minimumReleaseAgeExclude:',
        "        - '@clack/prompts@1.5.1'",
        '',
      ].join('\n'),
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-install-policy.ts');
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('fails the install-policy check when the committed policy has no explicit allowlist', async () => {
    const dir = fixture({
      'pnpm-workspace.yaml': [
        'minimumReleaseAge: 4320',
        '',
      ].join('\n'),
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-install-policy.ts');
    expect(code).toBe(1);
    expect(stderr).toContain(
      'install policy: pnpm allowBuilds must explicitly allow at least one trusted package',
    );
  });

  it('fails the repo-metadata check when required publish metadata drifts', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'fixture',
        packageManager: 'npm@10.0.0',
        publishConfig: { access: 'public', provenance: false },
      }),
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-repo-metadata.ts');
    expect(code).toBe(1);
    expect(stderr).toContain(
      'repo metadata: package.json packageManager must stay pinned to pnpm@11.5.1',
    );
    expect(stderr).toContain('repo metadata: package.json publishConfig must keep public access and provenance enabled');
  });

  it('passes the repo-metadata check for the expected release shape', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@11.5.1',
        publishConfig: { access: 'public', provenance: true },
      }),
    });

    const { code, stderr } = await runRepoScript(dir, 'scripts/check-repo-metadata.ts');
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });
});
