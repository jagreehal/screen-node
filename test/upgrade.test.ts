import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyUpgrades,
  classifyUpgrades,
  mergeProposals,
  ncuArgv,
  ncuPasses,
  parseUpgrades,
  rangeToVersion,
  readDeclaredRanges,
  renderUpgradeTable,
  upgradeTargets,
  type ProposedUpgrade,
  type UpgradePolicy,
} from '../src/upgrade.js';

const policy = (over: Partial<UpgradePolicy> = {}): UpgradePolicy => ({ cooldownDays: 7, target: 'latest', reject: [], filter: [], ...over });

describe('ncuArgv, config → ncu flags', () => {
  it('maps the release-age threshold onto --cooldown <n>d and asks for a JSON preview', () => {
    expect(ncuArgv(policy({ cooldownDays: 7 }), 'npm')).toEqual(
      ['--packageManager', 'npm', '--cooldown', '7d', '--jsonUpgraded'],
    );
  });

  it('omits --cooldown when the release-age gate is off (0 days)', () => {
    const argv = ncuArgv(policy({ cooldownDays: 0 }), 'pnpm');
    expect(argv).not.toContain('--cooldown');
    expect(argv).toEqual(['--packageManager', 'pnpm', '--jsonUpgraded']);
  });

  it('passes the package manager through so ncu uses the right lockfile/registry semantics', () => {
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      expect(ncuArgv(policy(), pm)).toContain(pm);
    }
  });

  it('adds --target only when not the default (latest)', () => {
    expect(ncuArgv(policy({ target: 'latest' }), 'npm')).not.toContain('--target');
    expect(ncuArgv(policy({ target: 'minor' }), 'npm')).toContain('minor');
  });

  it('joins reject and filter patterns into ncu\'s single space-delimited value', () => {
    const argv = ncuArgv(policy({ reject: ['react', '@types/*'], filter: ['lodash', 'zod'] }), 'npm');
    expect(argv[argv.indexOf('--reject') + 1]).toBe('react @types/*');
    expect(argv[argv.indexOf('--filter') + 1]).toBe('lodash zod');
    expect(argv.filter((a) => a === '--reject')).toHaveLength(1);
  });
});

describe('ncuPasses, honoring the per-package cooldown exemption', () => {
  it('is a single pass when there is no cooldown', () => {
    expect(ncuPasses(policy({ cooldownDays: 0 }), ['@me/*'], 'npm')).toHaveLength(1);
  });

  it('is a single pass when nothing is exempt', () => {
    expect(ncuPasses(policy({ cooldownDays: 7 }), [], 'npm')).toHaveLength(1);
  });

  it('splits into a gated pass and a cooldown-free exempt pass when both apply', () => {
    const passes = ncuPasses(policy({ cooldownDays: 7, reject: ['react'] }), ['@me/*'], 'npm');
    expect(passes).toHaveLength(2);
    const [gated, free] = passes as [string[], string[]];
    // gated pass: cooldown on, exempt patterns rejected out (alongside the explicit reject)
    expect(gated).toContain('--cooldown');
    expect(gated[gated.indexOf('--reject') + 1]).toBe('react @me/*');
    expect(gated).not.toContain('--filter');
    // exempt pass: no cooldown, filtered to ONLY the exempt patterns, explicit reject preserved
    expect(free).not.toContain('--cooldown');
    expect(free[free.indexOf('--filter') + 1]).toBe('@me/*');
    expect(free[free.indexOf('--reject') + 1]).toBe('react');
  });
});

describe('rangeToVersion', () => {
  it.each([
    ['^4.18.0', '4.18.0'],
    ['~1.2.3', '1.2.3'],
    ['>=2.0.0', '2.0.0'],
    ['v3.1.0', '3.1.0'],
    ['5.0.0', '5.0.0'],
  ])('strips the range operator: %s → %s', (range, version) => {
    expect(rangeToVersion(range)).toBe(version);
  });
});

describe('parseUpgrades', () => {
  const current = { lodash: '^4.17.20', zod: '^3.22.0' };

  it('pairs each ncu upgrade with the range currently declared, sorted by name', () => {
    const out = parseUpgrades('{"zod":"^3.23.0","lodash":"^4.17.21"}', current);
    expect(out).toEqual([
      { name: 'lodash', from: '^4.17.20', to: '^4.17.21' },
      { name: 'zod', from: '^3.22.0', to: '^3.23.0' },
    ]);
  });

  it('marks a dep with no declared range as, rather than dropping it', () => {
    expect(parseUpgrades('{"newdep":"^1.0.0"}', current)[0]).toMatchObject({ name: 'newdep', from: '-' });
  });

  it('returns [] for ncu\'s empty result and for unparseable output', () => {
    expect(parseUpgrades('{}', current)).toEqual([]);
    expect(parseUpgrades('not json', current)).toEqual([]);
    expect(parseUpgrades('', current)).toEqual([]);
  });
});

describe('mergeProposals', () => {
  it('unions the passes, de-duplicates by name (first wins), and sorts', () => {
    const a: ProposedUpgrade[] = [{ name: 'zod', from: '^3', to: '^4' }];
    const b: ProposedUpgrade[] = [
      { name: 'lodash', from: '^4.17.0', to: '^4.17.21' },
      { name: 'zod', from: '^3', to: '^3.99' }, // duplicate name — the first pass wins
    ];
    expect(mergeProposals([a, b])).toEqual([
      { name: 'lodash', from: '^4.17.0', to: '^4.17.21' },
      { name: 'zod', from: '^3', to: '^4' },
    ]);
  });
});

describe('upgradeTargets', () => {
  it('produces concrete name@version risk targets from the proposed ranges', () => {
    const ups: ProposedUpgrade[] = [{ name: 'lodash', from: '^4.17.20', to: '^4.17.21' }];
    expect(upgradeTargets(ups)).toEqual([{ name: 'lodash', spec: '4.17.21' }]);
  });
});

describe('classifyUpgrades, gate precedence', () => {
  const ups: ProposedUpgrade[] = [
    { name: 'clean', from: '1.0.0', to: '1.1.0' },
    { name: 'fresh', from: '1.0.0', to: '2.0.0' },
    { name: 'bad', from: '1.0.0', to: '9.9.9' },
    { name: 'old', from: '1.0.0', to: '3.0.0' },
  ];

  it('tags each proposal with the worst gate it trips (malware > deprecated > age > ok)', () => {
    const rows = classifyUpgrades(ups, {
      ageNames: new Set(['fresh', 'bad']),
      malwareNames: new Set(['bad']),
      deprecatedNames: new Set(['old']),
    });
    const gate = Object.fromEntries(rows.map((r) => [r.name, r.gate]));
    expect(gate).toEqual({ clean: 'ok', fresh: 'age', bad: 'malware', old: 'deprecated' });
  });
});

describe('renderUpgradeTable', () => {
  it('shows from → to and a badge only for gated rows', () => {
    const table = renderUpgradeTable([
      { name: 'lodash', from: '^4.17.20', to: '^4.17.21', gate: 'ok' },
      { name: 'evil', from: '^1.0.0', to: '^2.0.0', gate: 'malware' },
    ]);
    expect(table).toContain('→');
    expect(table).toContain('MALWARE');
    expect(table.split('\n').find((l) => l.includes('lodash'))).not.toContain('✖');
  });
});

describe('readDeclaredRanges', () => {
  it('collects ranges from every dependency field', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-upg-'));
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '^4.17.20' },
        devDependencies: { vitest: '^4.0.0' },
        optionalDependencies: { fsevents: '^2.3.0' },
        peerDependencies: { react: '^18.0.0' },
      }),
    );
    expect(readDeclaredRanges(dir)).toEqual({
      lodash: '^4.17.20',
      vitest: '^4.0.0',
      fsevents: '^2.3.0',
      react: '^18.0.0',
    });
  });

  it('returns {} when package.json is missing or unreadable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-upg-'));
    expect(readDeclaredRanges(dir)).toEqual({});
  });
});

describe('applyUpgrades, write exactly what was gated', () => {
  const pkg = JSON.stringify(
    {
      name: 'demo',
      dependencies: { lodash: '^4.17.0' },
      devDependencies: { vitest: '^4.0.0' },
    },
    null,
    2,
  );

  it('updates each dep in whichever field declares it, leaving others untouched', () => {
    const out = applyUpgrades(pkg, [
      { name: 'lodash', from: '^4.17.0', to: '^4.17.21' },
      { name: 'vitest', from: '^4.0.0', to: '^4.1.8' },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.dependencies.lodash).toBe('^4.17.21');
    expect(parsed.devDependencies.vitest).toBe('^4.1.8');
    expect(parsed.name).toBe('demo');
  });

  it('preserves two-space indentation and ends with a trailing newline', () => {
    const out = applyUpgrades(pkg, [{ name: 'lodash', from: '^4.17.0', to: '^4.17.21' }]);
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).toContain('\n  "dependencies"');
  });

  it('preserves tab indentation when the file uses tabs', () => {
    const tabbed = JSON.stringify({ dependencies: { lodash: '^4.17.0' } }, null, '\t');
    const out = applyUpgrades(tabbed, [{ name: 'lodash', from: '^4.17.0', to: '^4.17.21' }]);
    expect(out).toContain('\n\t"dependencies"');
  });

  it('ignores a proposal for a package not declared anywhere', () => {
    const out = applyUpgrades(pkg, [{ name: 'ghost', from: '-', to: '^9.0.0' }]);
    expect(JSON.parse(out)).toEqual(JSON.parse(pkg));
  });
});
