import { describe, expect, it } from 'vitest';
import { runScan } from '../src/scan.js';
import type { AdvisoryClient } from '../src/advisory.js';
import type { LockfilePackage } from '../src/risk.js';

const advisoryFor = (map: Record<string, string[]>): AdvisoryClient => ({
  async query(name: string, version: string): Promise<string[]> {
    return map[`${name}@${version}`] ?? [];
  },
});

const lock: LockfilePackage[] = [
  { name: 'left-pad', version: '1.3.0' },
  { name: 'evil', version: '6.6.6' },
  { name: 'lodash', version: '4.17.21' },
];
const read = (): LockfilePackage[] => lock;

describe('runScan', () => {
  it('flags an installed package now reported as malware', async () => {
    const res = await runScan({ pm: 'npm', cwd: '/x', readLockfile: read, advisoryClient: advisoryFor({ 'evil@6.6.6': ['MAL-2026-1'] }) });
    expect(res.lockfileMissing).toBe(false);
    expect(res.scanned).toBe(3);
    expect(res.malware.map((h) => h.name)).toEqual(['evil']);
    expect(res.malware[0]!.ids).toContain('MAL-2026-1');
  });

  it('separates non-malware advisories from malware', async () => {
    const res = await runScan({ pm: 'npm', cwd: '/x', readLockfile: read, advisoryClient: advisoryFor({ 'lodash@4.17.21': ['GHSA-xxxx'] }) });
    expect(res.malware).toHaveLength(0);
    expect(res.hits.map((h) => h.name)).toEqual(['lodash']);
    expect(res.hits[0]!.malware).toBe(false);
  });

  it('reports a clean tree', async () => {
    const res = await runScan({ pm: 'npm', cwd: '/x', readLockfile: read, advisoryClient: advisoryFor({}) });
    expect(res.hits).toHaveLength(0);
    expect(res.malware).toHaveLength(0);
    expect(res.scanned).toBe(3);
  });

  it('flags lockfileMissing when nothing is parseable (e.g. bun / no lockfile)', async () => {
    const res = await runScan({ pm: 'bun', cwd: '/x', readLockfile: () => [], advisoryClient: advisoryFor({}) });
    expect(res.lockfileMissing).toBe(true);
    expect(res.scanned).toBe(0);
  });

  it('dedupes the scanned count by name@version', async () => {
    const dup: LockfilePackage[] = [
      { name: 'a', version: '1' },
      { name: 'a', version: '1' },
      { name: 'b', version: '2' },
    ];
    const res = await runScan({ pm: 'npm', cwd: '/x', readLockfile: () => dup, advisoryClient: advisoryFor({}) });
    expect(res.scanned).toBe(2);
  });

  it('flags an installed package that matches the local blocklist (independent of OSV)', async () => {
    const res = await runScan({
      pm: 'npm', cwd: '/x', readLockfile: read, advisoryClient: advisoryFor({}),
      knownBad: [{ name: 'evil', source: 'screen.advisories.json' }],
    });
    expect(res.malware).toHaveLength(0);
    expect(res.knownBadHits.map((h) => h.name)).toEqual(['evil']);
  });
});
