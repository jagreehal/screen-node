import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectFacts } from '../src/project.js';
import { checkReleaseAge, checkReleaseAgeDeep, collectRiskHints, createRegistryClient, execPackageTargets, isExcluded, parsePackageTargets, planRiskHintLog, readAllPackagesFromLockfile, readDirectVersionsFromLockfile, REGISTRY_TIMEOUT_MS, releaseAgeViolations, resolveRiskTargets, riskTargetsForInstall, riskTargetsForUpdate, suggestAgedVersion, type RegistryClient, type RiskHint, type ResolvedTarget } from '../src/risk.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const now = new Date('2026-06-08T12:00:00.000Z');

function lockfileFixture(name: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-risk-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), body);
  return dir;
}

function facts(cwd: string, pm: ProjectFacts['pm'], directDependencies: ProjectFacts['directDependencies']): ProjectFacts {
  return {
    cwd,
    pm,
    isYarnBerry: false,
    hasLockfile: true,
    hasPackageJson: true,
    scripts: {},
    directDependencies,
    existingPersistencePaths: [],
    homedir: '/home/dev',
    hostEnv: {},
    envFileValues: {},
  };
}

describe('riskTargetsForUpdate', () => {
  const deps = [
    { name: 'lodash', spec: '^4.17.0' },
    { name: 'react', spec: '~18.2.0' },
    { name: 'ui', spec: 'workspace:*' }, // non-registry — must be dropped
  ];
  const f = (d = deps) => facts('/x', 'npm', d);

  it('gates each direct dep against its RANGE so the registry resolves the incoming (newest-in-range) version', () => {
    expect(riskTargetsForUpdate(f(), [], false)).toEqual([
      { name: 'lodash', spec: '^4.17.0' },
      { name: 'react', spec: '~18.2.0' },
    ]); // `ui` (workspace:) dropped
  });

  it('--latest resolves against the dist-tag latest (empty spec), since it bumps past the range', () => {
    expect(riskTargetsForUpdate(f(), [], true)).toEqual([
      { name: 'lodash', spec: '' },
      { name: 'react', spec: '' },
    ]);
  });

  it('a named update restricts the gate to those packages', () => {
    expect(riskTargetsForUpdate(f(), ['react'], false)).toEqual([{ name: 'react', spec: '~18.2.0' }]);
  });

  it('returns nothing when there are no registry-resolvable direct deps', () => {
    expect(riskTargetsForUpdate(facts('/x', 'npm', [{ name: 'ui', spec: 'workspace:*' }]), [], false)).toEqual([]);
  });
});

const packuments: Record<string, unknown> = {
  sharp: {
    name: 'sharp',
    'dist-tags': { latest: '0.33.5' },
    time: {
      created: '2024-01-01T00:00:00.000Z',
      '0.33.5': '2026-06-08T06:00:00.000Z',
    },
    versions: {
      '0.33.5': {
        scripts: { postinstall: 'node install/check.js' },
        bin: { sharp: './cli.js' },
      },
    },
  },
  'new-pkg': {
    name: 'new-pkg',
    'dist-tags': { latest: '1.2.3' },
    time: {
      created: '2026-06-05T12:00:00.000Z',
      '1.2.3': '2026-06-08T09:00:00.000Z',
    },
    versions: {
      '1.2.3': {},
    },
  },
  'deprecated-pkg': {
    name: 'deprecated-pkg',
    'dist-tags': { latest: '2.88.2' },
    time: {
      created: '2019-01-01T00:00:00.000Z',
      '2.88.2': '2020-01-01T00:00:00.000Z',
    },
    versions: {
      '2.88.2': { deprecated: 'request has been deprecated' },
    },
  },
  'range-pkg': {
    name: 'range-pkg',
    'dist-tags': { latest: '2.0.0' },
    time: {
      created: '2022-01-01T00:00:00.000Z',
      '1.4.0': '2024-01-01T00:00:00.000Z',
      '1.5.0': '2024-02-01T00:00:00.000Z',
      '2.0.0': '2024-03-01T00:00:00.000Z',
    },
    versions: {
      '1.4.0': {},
      '1.5.0': {},
      '2.0.0': {},
    },
  },
};

const client: RegistryClient = {
  async getPackument(name: string) {
    const packument = packuments[name];
    if (!packument) throw new Error(`unexpected package: ${name}`);
    return packument as Awaited<ReturnType<RegistryClient['getPackument']>>;
  },
};

describe('parsePackageTargets', () => {
  it('extracts registry package specs from package-manager args', () => {
    expect(parsePackageTargets(['--save-dev', 'zod', '@scope/pkg@^1.2.3', '--tag', 'beta', 'sharp@0.33.5'])).toEqual([
      { name: 'zod', spec: '' },
      { name: '@scope/pkg', spec: '^1.2.3' },
      { name: 'sharp', spec: '0.33.5' },
    ]);
  });

  it('skips local, workspace, and url-based specs', () => {
    expect(parsePackageTargets(['./local', 'file:../pkg', 'workspace:*', 'https://example.com/x.tgz'])).toEqual([]);
  });
});

describe('execPackageTargets', () => {
  it('extracts the fetched package from npx / bunx / dlx / npm exec', () => {
    expect(execPackageTargets(['npx', 'cowsay', 'hello'])).toEqual([{ name: 'cowsay', spec: '' }]); // "hello" is cowsay's arg
    expect(execPackageTargets(['bunx', 'create-vite@5', 'my-app'])).toEqual([{ name: 'create-vite', spec: '5' }]);
    expect(execPackageTargets(['bun', 'x', 'create-vite@5', 'my-app'])).toEqual([{ name: 'create-vite', spec: '5' }]);
    expect(execPackageTargets(['pnpm', 'dlx', '@scope/tool@^1.0.0'])).toEqual([{ name: '@scope/tool', spec: '^1.0.0' }]);
    expect(execPackageTargets(['yarn', 'dlx', 'tsx', 'script.ts'])).toEqual([{ name: 'tsx', spec: '' }]);
    expect(execPackageTargets(['npm', 'exec', '--', 'tsc'])).toEqual([{ name: 'tsc', spec: '' }]);
  });

  it('honours -p/--package and skips boolean/value flags', () => {
    expect(execPackageTargets(['npx', '-y', 'eslint'])).toEqual([{ name: 'eslint', spec: '' }]);
    expect(execPackageTargets(['npx', '-p', 'left-pad', '-p', 'right-pad', '-c', 'do-stuff'])).toEqual([
      { name: 'left-pad', spec: '' },
      { name: 'right-pad', spec: '' },
    ]);
  });

  it('returns [] for commands that run your own code, not a fetched package', () => {
    expect(execPackageTargets(['node', 'server.js'])).toEqual([]);
    expect(execPackageTargets(['vite'])).toEqual([]);
    expect(execPackageTargets(['npm', 'run', 'dev'])).toEqual([]);
    expect(execPackageTargets(['npx', './local-script'])).toEqual([]); // local path, not a registry package
  });
});

describe('resolveRiskTargets', () => {
  it('resolves tags and semver ranges to an exact version', async () => {
    const resolved = await resolveRiskTargets(
      [
        { name: 'sharp', spec: '' },
        { name: 'range-pkg', spec: '^1.4.0' },
      ],
      client,
    );
    expect(resolved.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual(['sharp@0.33.5', 'range-pkg@1.5.0']);
  });
});

describe('collectRiskHints', () => {
  it('emits install-script, recent-version, new-package, bin, and deprecation hints', async () => {
    const hints = await collectRiskHints(
      [
        { name: 'sharp', spec: '0.33.5' },
        { name: 'new-pkg', spec: '' },
        { name: 'deprecated-pkg', spec: '2.88.2' },
      ],
      { client, now },
    );

    expect(hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'install_script',
          package: 'sharp',
          version: '0.33.5',
          message: 'has postinstall script, contained in sandbox',
        }),
        expect.objectContaining({
          code: 'recent_version',
          package: 'sharp',
          version: '0.33.5',
          level: 'error',
          message: 'very recently published 6 hours ago; fresh releases are the supply-chain worm window',
        }),
        expect.objectContaining({
          code: 'bin_exposed',
          package: 'sharp',
          version: '0.33.5',
          detail: { bin: 'sharp -> ./cli.js' },
        }),
        expect.objectContaining({
          code: 'new_package',
          package: 'new-pkg',
          version: '1.2.3',
          message: 'first published 3 days ago; still a young package',
        }),
        expect.objectContaining({
          code: 'deprecated',
          package: 'deprecated-pkg',
          version: '2.88.2',
          message: 'deprecated: request has been deprecated',
        }),
      ]),
    );
  });
});

describe('readDirectVersionsFromLockfile', () => {
  it('reads exact direct versions from package-lock.json', () => {
    const cwd = lockfileFixture(
      'package-lock.json',
      JSON.stringify({
        packages: {
          '': { name: 'x' },
          'node_modules/zod': { version: '4.1.12' },
          'node_modules/@scope/pkg': { version: '1.2.3' },
        },
      }),
    );
    expect(readDirectVersionsFromLockfile(cwd, 'npm')).toEqual(
      new Map([
        ['zod', '4.1.12'],
        ['@scope/pkg', '1.2.3'],
      ]),
    );
  });

  it('reads exact direct versions from pnpm-lock.yaml', () => {
    const cwd = lockfileFixture(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      zod:
        specifier: ^4.0.0
        version: 4.1.12
      '@scope/pkg':
        specifier: ^1.0.0
        version: 1.2.3(@types/node@22.0.0)
`,
    );
    expect(readDirectVersionsFromLockfile(cwd, 'pnpm')).toEqual(
      new Map([
        ['zod', '4.1.12'],
        ['@scope/pkg', '1.2.3'],
      ]),
    );
  });

  it('reads exact direct versions from yarn.lock', () => {
    const cwd = lockfileFixture(
      'yarn.lock',
      `"zod@^4.0.0":
  version "4.1.12"

"@scope/pkg@^1.0.0", "@scope/pkg@~1.2.0":
  version "1.2.3"
`,
    );
    expect(readDirectVersionsFromLockfile(cwd, 'yarn')).toEqual(
      new Map([
        ['zod@^4.0.0', '4.1.12'],
        ['@scope/pkg@^1.0.0', '1.2.3'],
        ['@scope/pkg@~1.2.0', '1.2.3'],
      ]),
    );
  });
});

describe('riskTargetsForInstall', () => {
  it('prefers exact versions from the current lockfile over package.json ranges', () => {
    const npmCwd = lockfileFixture(
      'package-lock.json',
      JSON.stringify({ packages: { 'node_modules/sharp': { version: '0.33.5' } } }),
    );
    const pnpmCwd = lockfileFixture(
      'pnpm-lock.yaml',
      `importers:
  .:
    dependencies:
      sharp:
        specifier: ^0.33.0
        version: 0.33.5
`,
    );
    const yarnCwd = lockfileFixture(
      'yarn.lock',
      `"sharp@^0.33.0":
  version "0.33.5"
`,
    );

    expect(riskTargetsForInstall(facts(npmCwd, 'npm', [{ name: 'sharp', spec: '^0.33.0' }]))).toEqual([{ name: 'sharp', spec: '0.33.5' }]);
    expect(riskTargetsForInstall(facts(pnpmCwd, 'pnpm', [{ name: 'sharp', spec: '^0.33.0' }]))).toEqual([{ name: 'sharp', spec: '0.33.5' }]);
    expect(riskTargetsForInstall(facts(yarnCwd, 'yarn', [{ name: 'sharp', spec: '^0.33.0' }]))).toEqual([{ name: 'sharp', spec: '0.33.5' }]);
  });

  it('drops local workspace:/file:/link: deps so they never resolve as a bare registry name', () => {
    const cwd = lockfileFixture('package-lock.json', '{}');
    const targets = riskTargetsForInstall(
      facts(cwd, 'npm', [
        { name: 'zod', spec: '^4.0.0' },
        { name: '@me/db', spec: 'workspace:*' },
        { name: 'local-pkg', spec: 'file:../local' },
        { name: 'linked', spec: 'link:../linked' },
      ]),
    );
    expect(targets).toEqual([{ name: 'zod', spec: '^4.0.0' }]); // the workspace/file/link deps are gone, not resurrected
  });
});

describe('resolveVersion, prerelease handling', () => {
  const preClient: RegistryClient = {
    async getPackument() {
      return {
        name: 'x',
        'dist-tags': { latest: '1.2.0' },
        versions: { '1.1.5': {}, '1.2.0': {}, '1.3.0-beta.0': {}, '2.0.0-rc.1': {} },
        time: {},
      } as Awaited<ReturnType<RegistryClient['getPackument']>>;
    },
  };

  it('resolves a caret range to the latest STABLE version, ignoring newer prereleases', async () => {
    const resolved = await resolveRiskTargets([{ name: 'x', spec: '^1.1.0' }], preClient);
    expect(resolved[0]?.version).toBe('1.2.0'); // never 1.3.0-beta.0 or 2.0.0-rc.1
  });

  it('honours a prerelease when it is pinned exactly', async () => {
    const resolved = await resolveRiskTargets([{ name: 'x', spec: '1.3.0-beta.0' }], preClient);
    expect(resolved[0]?.version).toBe('1.3.0-beta.0');
  });
});

describe('registry client timeout', () => {
  it('defaults to a 5s cap', () => {
    expect(REGISTRY_TIMEOUT_MS).toBe(5000);
  });

  it('aborts (rejects) when the registry hangs past the timeout', async () => {
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
      })) as unknown as typeof fetch;
    const client = createRegistryClient(hangingFetch, 'https://registry.npmjs.org', 20);
    await expect(client.getPackument('left-pad')).rejects.toThrow();
  });
});

describe('releaseAgeViolations (pure)', () => {
  const now = new Date('2026-06-08T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const resolved = (name: string, publishedAt?: string): ResolvedTarget => ({
    name,
    spec: '',
    version: '1.0.0',
    manifest: {},
    publishedAt: publishedAt ? new Date(publishedAt) : undefined,
    packument: { name, versions: { '1.0.0': {} } },
  });

  it('flags only versions younger than the threshold', () => {
    const targets = [
      resolved('fresh', '2026-06-08T06:00:00.000Z'), // 6h old
      resolved('aged', '2026-05-01T00:00:00.000Z'), // ~38 days old
      resolved('undated'), // no publish time → can't judge → not flagged
    ];
    const v = releaseAgeViolations(targets, 7 * DAY, now);
    expect(v.map((x) => x.name)).toEqual(['fresh']);
    expect(v[0]!.ageMs).toBe(6 * 60 * 60 * 1000);
  });

  it('a 0ms threshold flags nothing (gate disabled)', () => {
    expect(releaseAgeViolations([resolved('fresh', '2026-06-08T11:59:00.000Z')], 0, now)).toEqual([]);
  });
});

describe('checkReleaseAge', () => {
  const now = new Date('2026-06-08T12:00:00.000Z');

  it('blocks a freshly-published version (sharp@0.33.5, 6h old) under a 1-day gate', async () => {
    const v = await checkReleaseAge([{ name: 'sharp', spec: '0.33.5' }], 1, { client, now });
    expect(v).toHaveLength(1);
    expect(v[0]!.name).toBe('sharp');
  });
});

describe('isExcluded (release-age gate exclusions)', () => {
  it('matches exact names and * globs', () => {
    expect(isExcluded('@myscope/app', ['@myscope/*'])).toBe(true);
    expect(isExcluded('internal-tool', ['internal-*'])).toBe(true);
    expect(isExcluded('left-pad', ['@myscope/*', 'internal-*'])).toBe(false);
    expect(isExcluded('lodash', ['lodash'])).toBe(true);
  });
});

describe('checkReleaseAge exclude', () => {
  const now = new Date('2026-06-08T12:00:00.000Z');
  it('skips excluded package names (no violation even when fresh)', async () => {
    // sharp@0.33.5 is 6h old in the fixture → would violate at 1 day
    const v = await checkReleaseAge([{ name: 'sharp', spec: '0.33.5' }], 1, { client, now, exclude: ['sharp'] });
    expect(v).toEqual([]);
  });
});

describe('readAllPackagesFromLockfile (transitive)', () => {
  it('npm: every node_modules entry including nested', () => {
    const cwd = lockfileFixture('package-lock.json', JSON.stringify({
      packages: {
        '': { name: 'x' },
        'node_modules/foo': { version: '1.0.0' },
        'node_modules/bar': { version: '2.0.0' },
        'node_modules/foo/node_modules/baz': { version: '3.0.0' },
      },
    }));
    const all = readAllPackagesFromLockfile(cwd, 'npm');
    expect(all).toContainEqual({ name: 'foo', version: '1.0.0' });
    expect(all).toContainEqual({ name: 'bar', version: '2.0.0' });
    expect(all).toContainEqual({ name: 'baz', version: '3.0.0' });
  });

  it('pnpm: keys in the packages: section (scoped + plain)', () => {
    const cwd = lockfileFixture('pnpm-lock.yaml', `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  foo@1.0.0:
    resolution: {integrity: sha512-aaa}
  '@scope/bar@2.0.0':
    resolution: {integrity: sha512-bbb}
snapshots:
  foo@1.0.0: {}
`);
    const all = readAllPackagesFromLockfile(cwd, 'pnpm');
    expect(all).toContainEqual({ name: 'foo', version: '1.0.0' });
    expect(all).toContainEqual({ name: '@scope/bar', version: '2.0.0' });
  });

  it('bun: returns empty (no parser; caller falls back)', () => {
    const cwd = lockfileFixture('bun.lock', '{}');
    expect(readAllPackagesFromLockfile(cwd, 'bun')).toEqual([]);
  });
});

describe('checkReleaseAgeDeep', () => {
  const now = new Date('2026-06-08T12:00:00.000Z');
  const deepClient: RegistryClient = {
    async getPackument(name: string) {
      const map: Record<string, unknown> = {
        fresh: { name: 'fresh', versions: { '1.0.0': {} }, time: { '1.0.0': '2026-06-08T06:00:00.000Z' } }, // 6h old
        aged: { name: 'aged', versions: { '1.0.0': {} }, time: { '1.0.0': '2026-01-01T00:00:00.000Z' } },
      };
      const p = map[name];
      if (!p) throw new Error(`unexpected ${name}`);
      return p as Awaited<ReturnType<RegistryClient['getPackument']>>;
    },
  };

  it('flags fresh transitive versions and respects exclude', async () => {
    const pkgs = [{ name: 'fresh', version: '1.0.0' }, { name: 'aged', version: '1.0.0' }];
    const v = await checkReleaseAgeDeep(pkgs, 1, { client: deepClient, now });
    expect(v.map((x) => x.name)).toEqual(['fresh']);

    const excluded = await checkReleaseAgeDeep(pkgs, 1, { client: deepClient, now, exclude: ['fresh'] });
    expect(excluded).toEqual([]);
  });
});

describe('suggestAgedVersion, the known-good older version to pin', () => {
  // latest (1.3.0) is fresh; 1.2.0 is well-aged; 1.2.1 is a fresh patch; 1.3.0-rc.1 a prerelease;
  // 0.9.0 is deprecated. The pick must be the NEWEST stable, non-deprecated, aged-in version: 1.2.0.
  const client: RegistryClient = {
    async getPackument(name: string) {
      if (name !== 'left-pad') throw new Error(`unexpected ${name}`);
      return {
        name: 'left-pad',
        'dist-tags': { latest: '1.3.0' },
        versions: {
          '0.9.0': { deprecated: 'do not use' },
          '1.2.0': {},
          '1.2.1': {},
          '1.3.0-rc.1': {},
          '1.3.0': {},
        },
        time: {
          created: '2020-01-01T00:00:00.000Z',
          '0.9.0': '2020-02-01T00:00:00.000Z',
          '1.2.0': '2026-01-01T00:00:00.000Z', // aged
          '1.2.1': '2026-06-08T06:00:00.000Z', // 6h old — too fresh
          '1.3.0-rc.1': '2025-01-01T00:00:00.000Z', // aged but prerelease
          '1.3.0': '2026-06-08T06:00:00.000Z', // 6h old — too fresh
        },
      } as Awaited<ReturnType<RegistryClient['getPackument']>>;
    },
  };

  it('picks the newest stable, non-deprecated, sufficiently-aged version', async () => {
    const aged = await suggestAgedVersion('left-pad', 7 * DAY_MS, { client, now });
    expect(aged?.version).toBe('1.2.0');
    expect(aged!.ageMs).toBeGreaterThan(7 * DAY_MS);
  });

  it('returns undefined when nothing is old enough', async () => {
    const aged = await suggestAgedVersion('left-pad', 3650 * DAY_MS, { client, now });
    expect(aged).toBeUndefined();
  });

  it('fails open (undefined) when the registry is unreachable', async () => {
    const down: RegistryClient = { async getPackument() { throw new Error('registry down'); } };
    expect(await suggestAgedVersion('left-pad', DAY_MS, { client: down, now })).toBeUndefined();
  });
});

describe('planRiskHintLog, invisible when clean, clear when not', () => {
  const recent: RiskHint = { level: 'error', code: 'recent_version', package: 'sharp', version: '0.99.0', message: 'very recently published 2 hours ago; fresh releases are the supply-chain worm window', detail: { severity: 'strong' } as never };
  const bin: RiskHint = { level: 'warn', code: 'bin_exposed', package: 'sharp', version: '0.99.0', message: '', detail: { bin: 'sharp -> ./cli.js' } };

  it('stays SILENT on the install path when nothing is flagged (debug, not info)', () => {
    const lines = planRiskHintLog(3, [], { contained: true });
    expect(lines).toEqual([{ level: 'debug', text: 'checked 3 packages for registry risk hints' }]);
  });

  it('still CONFIRMS the look on an explicit check when nothing is flagged (info)', () => {
    const lines = planRiskHintLog(3, [], { contained: false });
    expect(lines).toEqual([{ level: 'info', text: 'checked 3 packages for registry risk hints' }]);
  });

  it('emits nothing at all when there were no targets and no hints', () => {
    expect(planRiskHintLog(0, [], { contained: true })).toEqual([]);
  });

  it('groups hints per package and closes with the native-default "heads-up only" line', () => {
    const lines = planRiskHintLog(1, [recent, bin], { contained: true });
    expect(lines[0]).toEqual({ level: 'info', text: 'checked 1 package for registry risk hints' });
    expect(lines[1]).toEqual({ level: 'warn', text: '1 thing worth a look before installing' }); // a bin is the boundary doing its job — it never counts toward the headline
    // recent_version is error-level → the package block is error, with both hints grouped under it.
    expect(lines[2]!.level).toBe('error');
    expect(lines[2]!.text).toContain('sharp@0.99.0');
    expect(lines[2]!.text).toContain('!! very recently published'); // strong recent_version gets the !! emphasis
    expect(lines[2]!.text).toContain('adds bin: sharp -> ./cli.js'); // bin still shown as a sub-line next to a real finding
    expect(lines.at(-1)).toEqual({ level: 'info', text: expect.stringContaining('Want the real boundary too?') as unknown as string });
  });

  it('a bin is the only signal: package stays silent (debug) and the run reads as clean', () => {
    // No real finding anywhere → no "worth a look" headline, the bin block sinks to debug.
    const lines = planRiskHintLog(1, [bin], { contained: false });
    expect(lines).toEqual([{ level: 'info', text: 'checked 1 package for registry risk hints' }]);
  });

  it('closes with the check-context line (nothing installed) when not contained', () => {
    const lines = planRiskHintLog(1, [recent], { contained: false });
    expect(lines.at(-1)!.text).toContain('nothing was installed or downloaded');
  });

  it('leads with error-level packages, so the ✖ block is never buried mid-list', () => {
    // A warn package generated FIRST, an error package generated SECOND: severity must win over order.
    const warnPkg: RiskHint = { level: 'warn', code: 'install_script', package: 'basic-ftp', version: '5.3.1', message: 'has prepare script, contained in sandbox', detail: { script: 'prepare' } };
    const errPkg: RiskHint = { level: 'error', code: 'provenance_regression', package: 'awaitly', version: '1.34.0', message: 'version 1.33.3 shipped npm provenance but 1.34.0 dropped it', detail: { priorVersion: '1.33.3' } };
    const lines = planRiskHintLog(2, [warnPkg, errPkg], { contained: false });
    const blocks = lines.filter((l) => l.text.includes('@'));
    expect(blocks[0]!.level).toBe('error');
    expect(blocks[0]!.text).toContain('awaitly@1.34.0');
    expect(blocks[1]!.text).toContain('basic-ftp@5.3.1');
  });

  it('offers an aged version under a freshness hint, framed as age and with a copy-pasteable pin', () => {
    const fresh: RiskHint = { level: 'warn', code: 'recent_version', package: 'vitest', version: '4.1.6', message: 'recently published 2 days ago; fresh releases are the supply-chain worm window', detail: { publishedAt: '2026-06-17T00:00:00.000Z', severity: 'light', aged: { version: '4.1.4', ageMs: 18 * 24 * 60 * 60 * 1000 } } };
    const lines = planRiskHintLog(1, [fresh], { contained: false, pm: 'pnpm' });
    const block = lines.find((l) => l.text.includes('vitest@4.1.6'))!;
    expect(block.text).toContain('↳ 4.1.4 predates the worm window (published 18 days ago)');
    expect(block.text).toContain('sandbox pnpm add vitest@4.1.4');
    expect(block.text).not.toMatch(/safe|known-good/i); // age is the only claim
  });
})
