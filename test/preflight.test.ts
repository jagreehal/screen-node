import { describe, expect, it } from 'vitest';
import type { AdvisoryClient } from '../src/advisory.js';
import { runPreflight, suggestPins, type PreflightPolicy } from '../src/preflight.js';
import type { LockfilePackage, RegistryClient, ReleaseAgeViolation } from '../src/risk.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const SIX_HOURS_AGO = '2026-06-08T06:00:00.000Z';

/** Registry client that records how many packuments it fetched (to prove one shared resolve). */
function countingRegistry(): { client: RegistryClient; calls: () => number } {
  let calls = 0;
  const client: RegistryClient = {
    async getPackument(name: string) {
      calls += 1;
      return {
        name,
        'dist-tags': { latest: '0.33.5' },
        versions: { '0.33.5': { scripts: { postinstall: 'node x.js' } }, '1.0.0': {} },
        time: { created: '2024-01-01T00:00:00.000Z', '0.33.5': SIX_HOURS_AGO, '1.0.0': SIX_HOURS_AGO },
      } as Awaited<ReturnType<RegistryClient['getPackument']>>;
    },
  };
  return { client, calls: () => calls };
}

const malwareAdvisory: AdvisoryClient = { async query() { return ['MAL-2026-1']; } };

const policy = (over: Partial<PreflightPolicy> = {}): PreflightPolicy => ({
  riskHints: true,
  thorough: false,
  minReleaseAgeDays: 0,
  releaseAgeExclude: [],
  deep: false,
  advisories: false,
  ...over,
});

describe('runPreflight, single shared resolve', () => {
  it('resolves the registry ONCE and feeds hints + age gate + advisory from that one result', async () => {
    const { client, calls } = countingRegistry();
    const result = await runPreflight([{ name: 'sharp', spec: '0.33.5' }], policy({ minReleaseAgeDays: 1, advisories: true }), {
      pm: 'npm',
      cwd: '/x',
      registryClient: client,
      advisoryClient: malwareAdvisory,
      now: NOW,
    });
    expect(calls()).toBe(1); // the whole point: one packument fetch, not three
    expect(result.hints.length).toBeGreaterThan(0); // postinstall + recent-version hints
    expect(result.ageViolations.map((v) => v.name)).toEqual(['sharp']); // 6h < 1 day
    expect(result.advisoryHits[0]).toMatchObject({ name: 'sharp', malware: true });
  });

  it('does nothing (no resolve) when every gate is off', async () => {
    const { client, calls } = countingRegistry();
    const result = await runPreflight([{ name: 'sharp', spec: '' }], policy({ riskHints: false }), { pm: 'npm', cwd: '/x', registryClient: client, now: NOW });
    expect(calls()).toBe(0);
    expect(result).toMatchObject({ hints: [], ageViolations: [], advisoryHits: [] });
  });

  it('honours the release-age exclude (no violation for an exempt name)', async () => {
    const { client } = countingRegistry();
    const result = await runPreflight([{ name: 'sharp', spec: '0.33.5' }], policy({ riskHints: false, minReleaseAgeDays: 1, releaseAgeExclude: ['sharp'] }), {
      pm: 'npm', cwd: '/x', registryClient: client, now: NOW,
    });
    expect(result.ageViolations).toEqual([]);
  });

  it('does not block on a non-malware advisory', async () => {
    const { client } = countingRegistry();
    const result = await runPreflight([{ name: 'sharp', spec: '0.33.5' }], policy({ riskHints: false, advisories: true }), {
      pm: 'npm', cwd: '/x', registryClient: client, advisoryClient: { async query() { return ['GHSA-x']; } }, now: NOW,
    });
    expect(result.advisoryHits[0]).toMatchObject({ malware: false });
  });

  it('fails open: a registry error leaves empty findings (caller proceeds)', async () => {
    const throwing: RegistryClient = { async getPackument() { throw new Error('registry down'); } };
    const result = await runPreflight([{ name: 'sharp', spec: '' }], policy({ minReleaseAgeDays: 1, advisories: true }), {
      pm: 'npm', cwd: '/x', registryClient: throwing, advisoryClient: malwareAdvisory, now: NOW,
    });
    expect(result).toMatchObject({ hints: [], ageViolations: [], advisoryHits: [] });
  });

  it('matches the local blocklist over the resolved direct target (runs even with every gate off)', async () => {
    const { client, calls } = countingRegistry();
    const result = await runPreflight([{ name: 'sharp', spec: '0.33.5' }], policy({ riskHints: false }), {
      pm: 'npm', cwd: '/x', registryClient: client, now: NOW,
      knownBad: [{ name: 'sharp', reason: 'team block', severity: 'high', source: 'sandbox.advisories.json' }],
    });
    expect(calls()).toBe(1); // resolves to get the version even though no other gate is on
    expect(result.knownBadHits).toEqual([{ name: 'sharp', version: '0.33.5', reason: 'team block', severity: 'high', source: 'sandbox.advisories.json' }]);
  });

  it('matches the blocklist over the whole tree under --deep', async () => {
    const { client } = countingRegistry();
    const deepTree: LockfilePackage[] = [{ name: 'left-pad', version: '1.0.0' }, { name: 'evil', version: '6.6.6' }];
    const result = await runPreflight([{ name: 'left-pad', spec: '' }], policy({ riskHints: false, deep: true }), {
      pm: 'pnpm', cwd: '/x', registryClient: client, now: NOW, readLockfile: () => deepTree,
      knownBad: [{ name: 'evil', source: 'feed' }],
    });
    expect(result.knownBadHits.map((h) => h.name)).toEqual(['evil']);
  });
});

describe('suggestPins, concrete pin for each blocked package', () => {
  const violation = (name: string): ReleaseAgeViolation => ({ name, version: '1.3.0', publishedAt: new Date(SIX_HOURS_AGO), ageMs: 6 * 60 * 60 * 1000 });

  // 1.2.0 is aged-in; 1.3.0 (latest) is fresh. The pin must be 1.2.0.
  const pinRegistry: RegistryClient = {
    async getPackument(name: string) {
      return {
        name,
        'dist-tags': { latest: '1.3.0' },
        versions: { '1.2.0': {}, '1.3.0': {} },
        time: { created: '2024-01-01T00:00:00.000Z', '1.2.0': '2026-01-01T00:00:00.000Z', '1.3.0': SIX_HOURS_AGO },
      } as Awaited<ReturnType<RegistryClient['getPackument']>>;
    },
  };

  it('returns the newest aged-in version per blocked package, de-duplicated by name', async () => {
    const pins = await suggestPins([violation('left-pad'), violation('left-pad'), violation('is-odd')], 7, { client: pinRegistry, now: NOW });
    expect(pins).toEqual([
      { name: 'left-pad', version: '1.2.0', ageMs: expect.any(Number) },
      { name: 'is-odd', version: '1.2.0', ageMs: expect.any(Number) },
    ]);
  });

  it('omits a package with no aged-in version (registry down or all fresh)', async () => {
    const down: RegistryClient = { async getPackument() { throw new Error('down'); } };
    expect(await suggestPins([violation('left-pad')], 7, { client: down, now: NOW })).toEqual([]);
  });
});

describe('runPreflight, deep gate', () => {
  const deepTree: LockfilePackage[] = [{ name: 'transitive', version: '1.0.0' }];

  it('gates the lockfile tree and reports deepCount; skips the direct resolve when nothing else needs it', async () => {
    const { client, calls } = countingRegistry();
    const result = await runPreflight([], policy({ riskHints: false, minReleaseAgeDays: 1, deep: true, advisories: false }), {
      pm: 'pnpm', cwd: '/x', registryClient: client, now: NOW, readLockfile: () => deepTree,
    });
    expect(result.deepCount).toBe(1);
    expect(result.ageViolations.map((v) => v.name)).toEqual(['transitive']); // fresh in the fixture
    expect(calls()).toBe(1); // only the deep package, not a separate direct pass
  });

  it('falls back to the direct gate when the lockfile yields no tree', async () => {
    const { client } = countingRegistry();
    const result = await runPreflight([{ name: 'sharp', spec: '0.33.5' }], policy({ riskHints: false, minReleaseAgeDays: 1, deep: true }), {
      pm: 'bun', cwd: '/x', registryClient: client, now: NOW, readLockfile: () => [],
    });
    expect(result.deepCount).toBe(0);
    expect(result.ageViolations.map((v) => v.name)).toEqual(['sharp']); // direct fallback gated it
  });

  it('flags a DEPRECATED transitive version over the deep tree (riskHints on, no age gate)', async () => {
    const deprecatedRegistry: RegistryClient = {
      async getPackument(name: string) {
        return { name, versions: { '1.0.0': { deprecated: 'abandoned, do not use' } }, time: { '1.0.0': '2024-01-01T00:00:00.000Z' } } as Awaited<ReturnType<RegistryClient['getPackument']>>;
      },
    };
    const result = await runPreflight([], policy({ riskHints: true, minReleaseAgeDays: 0, deep: true }), {
      pm: 'pnpm', cwd: '/x', registryClient: deprecatedRegistry, now: NOW, readLockfile: () => [{ name: 'left-pad', version: '1.0.0' }],
    });
    expect(result.deepCount).toBe(1);
    const deprecated = result.hints.filter((h) => h.code === 'deprecated');
    expect(deprecated.map((h) => `${h.package}@${h.version}`)).toEqual(['left-pad@1.0.0']);
  });

  it('queries OSV for malware across the whole deep tree (advisory-only deep scan)', async () => {
    const { client, calls } = countingRegistry();
    const result = await runPreflight([], policy({ riskHints: false, minReleaseAgeDays: 0, advisories: true, deep: true }), {
      pm: 'pnpm', cwd: '/x', registryClient: client, advisoryClient: malwareAdvisory, now: NOW,
      readLockfile: () => [{ name: 'evil', version: '1.0.0' }, { name: 'evil-2', version: '2.0.0' }],
    });
    expect(result.advisoryHits.map((h) => h.name).sort()).toEqual(['evil', 'evil-2']);
    expect(result.advisoryHits.every((h) => h.malware)).toBe(true);
    expect(calls()).toBe(0); // advisory-only deep: no packument fetches, just OSV
  });
});
