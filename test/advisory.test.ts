import { describe, expect, it } from 'vitest';
import { checkAdvisories, isMalwareId, type AdvisoryClient } from '../src/advisory.js';
import type { RegistryClient } from '../src/risk.js';

const registry: RegistryClient = {
  async getPackument(name: string) {
    return {
      name,
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: { created: '2024-01-01T00:00:00.000Z', '1.0.0': '2024-06-01T00:00:00.000Z' },
    } as Awaited<ReturnType<RegistryClient['getPackument']>>;
  },
};

describe('isMalwareId', () => {
  it('recognises OSV MAL- ids (case-insensitive), not CVE/GHSA', () => {
    expect(isMalwareId('MAL-2026-1234')).toBe(true);
    expect(isMalwareId('mal-2026-1')).toBe(true);
    expect(isMalwareId('GHSA-xxxx')).toBe(false);
    expect(isMalwareId('CVE-2026-1')).toBe(false);
  });
});

describe('checkAdvisories', () => {
  const advisory = (ids: Record<string, string[]>): AdvisoryClient => ({
    async query(name: string) {
      return ids[name] ?? [];
    },
  });

  it('returns a hit with malware:true when a MAL- advisory matches', async () => {
    const hits = await checkAdvisories([{ name: 'evil-pkg', spec: '' }], {
      registryClient: registry,
      advisoryClient: advisory({ 'evil-pkg': ['MAL-2026-9999'] }),
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: 'evil-pkg', version: '1.0.0', malware: true });
  });

  it('returns a non-malware hit for a plain advisory', async () => {
    const hits = await checkAdvisories([{ name: 'vuln-pkg', spec: '' }], {
      registryClient: registry,
      advisoryClient: advisory({ 'vuln-pkg': ['GHSA-aaaa-bbbb'] }),
    });
    expect(hits[0]).toMatchObject({ malware: false });
  });

  it('returns nothing when there are no advisories', async () => {
    const hits = await checkAdvisories([{ name: 'clean-pkg', spec: '' }], {
      registryClient: registry,
      advisoryClient: advisory({}),
    });
    expect(hits).toEqual([]);
  });
});
