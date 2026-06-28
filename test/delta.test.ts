import { describe, expect, it } from 'vitest';
import { changedPackages, runDelta } from '../src/delta.js';
import type { AdvisoryClient } from '../src/advisory.js';
import type { LockfilePackage, RegistryClient } from '../src/risk.js';

const advisoryFor = (map: Record<string, string[]>): AdvisoryClient => ({
  async query(name: string, version: string): Promise<string[]> {
    return map[`${name}@${version}`] ?? [];
  },
});

describe('changedPackages', () => {
  it('returns added + version-bumped packages, not unchanged ones', () => {
    const base: LockfilePackage[] = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.0.0' }];
    const head: LockfilePackage[] = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '2.1.0' }, { name: 'c', version: '3.0.0' }];
    expect(changedPackages(base, head)).toEqual([{ name: 'b', version: '2.1.0' }, { name: 'c', version: '3.0.0' }]);
  });

  it('dedupes repeated head entries', () => {
    expect(changedPackages([], [{ name: 'a', version: '1' }, { name: 'a', version: '1' }])).toEqual([{ name: 'a', version: '1' }]);
  });

  it('is empty when nothing changed', () => {
    const same: LockfilePackage[] = [{ name: 'a', version: '1' }];
    expect(changedPackages(same, same)).toEqual([]);
  });
});

describe('runDelta', () => {
  const base: LockfilePackage[] = [{ name: 'a', version: '1.0.0' }];
  const head: LockfilePackage[] = [{ name: 'a', version: '1.0.0' }, { name: 'evil', version: '6.6.6' }, { name: 'ok', version: '2.0.0' }];

  it('gates ONLY changed packages for malware (unchanged deps are never queried)', async () => {
    const res = await runDelta(
      { minReleaseAgeDays: 0, releaseAgeExclude: [], advisories: true },
      // 'a' is unchanged, so even though it has a MAL- entry here it must NOT be reported.
      { pm: 'npm', cwd: '/x', base, readLockfile: () => head, advisoryClient: advisoryFor({ 'evil@6.6.6': ['MAL-1'], 'a@1.0.0': ['MAL-unchanged'] }) },
    );
    expect(res.changed.map((p) => p.name).sort()).toEqual(['evil', 'ok']);
    expect(res.advisoryHits.map((h) => h.name)).toEqual(['evil']);
    expect(res.advisoryHits[0]!.malware).toBe(true);
  });

  it('no changes vs base → nothing gated', async () => {
    const res = await runDelta(
      { minReleaseAgeDays: 0, releaseAgeExclude: [], advisories: true },
      { pm: 'npm', cwd: '/x', base, readLockfile: () => base, advisoryClient: advisoryFor({}) },
    );
    expect(res.changed).toEqual([]);
    expect(res.advisoryHits).toEqual([]);
  });

  it('baseMissing → treats all head packages as changed (gate-all) and surfaces the flag', async () => {
    const res = await runDelta(
      { minReleaseAgeDays: 0, releaseAgeExclude: [], advisories: true },
      { pm: 'npm', cwd: '/x', base: [], baseMissing: true, readLockfile: () => head, advisoryClient: advisoryFor({ 'evil@6.6.6': ['MAL-1'] }) },
    );
    expect(res.baseMissing).toBe(true);
    expect(res.changed).toHaveLength(3);
    expect(res.advisoryHits.map((h) => h.name)).toEqual(['evil']);
  });

  it('runs the release-age gate over the changed subset only', async () => {
    const now = new Date('2026-06-11T00:00:00Z');
    const registry: RegistryClient = {
      async getPackument(name: string) {
        return { name, versions: { '2.0.0': {} }, time: { '2.0.0': '2026-06-10T00:00:00Z' } } as Awaited<ReturnType<RegistryClient['getPackument']>>;
      },
    };
    const res = await runDelta(
      { minReleaseAgeDays: 7, releaseAgeExclude: [], advisories: false },
      { pm: 'npm', cwd: '/x', base: [{ name: 'ok', version: '1.0.0' }], readLockfile: () => [{ name: 'ok', version: '2.0.0' }], registryClient: registry, now },
    );
    expect(res.changed).toEqual([{ name: 'ok', version: '2.0.0' }]);
    expect(res.ageViolations.map((v) => v.name)).toEqual(['ok']);
  });
});
