import { afterEach, describe, expect, it } from 'vitest';
import {
  collectRiskHints,
  createDownloadsClient,
  defaultNsResolver,
  expiredDomainHints,
  levenshtein,
  lowDownloadHints,
  setTopPackagesForTest,
  type DownloadsClient,
  type NsResolver,
  type RegistryClient,
  type ResolvedTarget,
} from '../src/risk.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const TWO_YEARS_AGO = '2024-06-08T12:00:00.000Z';
const FIVE_DAYS_AGO = '2026-06-03T12:00:00.000Z';
const LONG_AGO = '2020-01-01T00:00:00.000Z';

/** Minimal registry serving a fixed packument table; throws on anything unexpected. */
function registryOf(packuments: Record<string, unknown>): RegistryClient {
  return {
    async getPackument(name: string) {
      const p = packuments[name];
      if (!p) throw new Error(`unexpected package: ${name}`);
      return p as Awaited<ReturnType<RegistryClient['getPackument']>>;
    },
  };
}

afterEach(() => setTopPackagesForTest(undefined)); // restore the bundled corpus

describe('levenshtein', () => {
  it('computes edit distance', () => {
    expect(levenshtein('lodash', 'lodash')).toBe(0);
    expect(levenshtein('lodash', 'lodahs')).toBe(2); // transposition = 2 single edits
    expect(levenshtein('chalk', 'chlk')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('early-exits past maxDistance (returns a value > the cap, not the exact distance)', () => {
    expect(levenshtein('abcdef', 'uvwxyz', 2)).toBeGreaterThan(2);
  });
});

describe('typosquat signal', () => {
  it('flags a name one or two edits from a popular package, with the matches', async () => {
    setTopPackagesForTest(['lodash', 'express', 'react']);
    const client = registryOf({ lodahs: { name: 'lodahs', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: 'lodahs', spec: '' }], { client, now: NOW });
    const typo = hints.find((h) => h.code === 'typosquat');
    expect(typo).toBeDefined();
    expect(typo?.level).toBe('error');
    expect(typo?.code === 'typosquat' && typo.detail.similarTo).toContain('lodash');
  });

  it('does not flag the popular package itself', async () => {
    setTopPackagesForTest(['lodash']);
    const client = registryOf({ lodash: { name: 'lodash', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: 'lodash', spec: '' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'typosquat')).toBe(false);
  });

  it('compares the unscoped name so @evil/loadsh still trips against lodash', async () => {
    setTopPackagesForTest(['lodash']);
    const client = registryOf({ '@evil/loadsh': { name: '@evil/loadsh', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: '@evil/loadsh', spec: '' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'typosquat')).toBe(true);
  });

  it('does not flag a short name like `ai` that lands near many unrelated short names', async () => {
    setTopPackagesForTest(['ajv', 'arg', 'ava', 'lodash']);
    const client = registryOf({ ai: { name: 'ai', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: 'ai', spec: '' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'typosquat')).toBe(false);
  });

  it('does not flag a member of a reputable scope (@typescript-eslint/parser vs parcel/terser)', async () => {
    // The scope owns a package in the corpus, so its members are trusted by namespace ownership —
    // even though the bare name `parser` is two edits from `parcel` and `terser`.
    setTopPackagesForTest(['@typescript-eslint/rule-tester', 'parcel', 'terser']);
    const client = registryOf({ '@typescript-eslint/parser': { name: '@typescript-eslint/parser', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: '@typescript-eslint/parser', spec: '' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'typosquat')).toBe(false);
  });

  it('does not flag a longer compound name two inserts from a popular one (tsconfig vs config)', async () => {
    // Distance 2 but different lengths — a legit compound word, not a same-length impersonation.
    setTopPackagesForTest(['@total-typescript/tsconfig', 'config']);
    const client = registryOf({ '@evil/tsconfig': { name: '@evil/tsconfig', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: '@evil/tsconfig', spec: '' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'typosquat')).toBe(false);
  });
});

describe('provenance-regression signal', () => {
  it('flags a version that dropped attestations an older version shipped', async () => {
    setTopPackagesForTest([]); // isolate from typosquat noise
    const client = registryOf({
      prov: {
        name: 'prov',
        'dist-tags': { latest: '2.0.0' },
        versions: { '1.0.0': { dist: { attestations: { url: 'x' } } }, '2.0.0': {} },
        time: { created: LONG_AGO, '1.0.0': LONG_AGO, '2.0.0': LONG_AGO },
      },
    });
    const hints = await collectRiskHints([{ name: 'prov', spec: '2.0.0' }], { client, now: NOW });
    const reg = hints.find((h) => h.code === 'provenance_regression');
    expect(reg).toBeDefined();
    expect(reg?.code === 'provenance_regression' && reg.detail.priorVersion).toBe('1.0.0');
  });

  it('does not flag when the installed version keeps provenance', async () => {
    setTopPackagesForTest([]);
    const client = registryOf({
      prov: {
        name: 'prov',
        'dist-tags': { latest: '2.0.0' },
        versions: { '1.0.0': { dist: { attestations: { url: 'x' } } }, '2.0.0': { dist: { attestations: { url: 'y' } } } },
        time: { created: LONG_AGO, '1.0.0': LONG_AGO, '2.0.0': LONG_AGO },
      },
    });
    const hints = await collectRiskHints([{ name: 'prov', spec: '2.0.0' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'provenance_regression')).toBe(false);
  });
});

describe('maintainer-change signal', () => {
  it('flags a first-ever, recent publish by a new publisher (takeover profile)', async () => {
    setTopPackagesForTest([]);
    const client = registryOf({
      takeover: {
        name: 'takeover',
        'dist-tags': { latest: '1.0.1' },
        versions: {
          '1.0.0': { _npmUser: { name: 'alice', email: 'alice@good.dev' } },
          '1.0.1': { _npmUser: { name: 'bob', email: 'bob@evil.dev' } },
        },
        time: { created: TWO_YEARS_AGO, '1.0.0': TWO_YEARS_AGO, '1.0.1': FIVE_DAYS_AGO },
      },
    });
    const hints = await collectRiskHints([{ name: 'takeover', spec: '1.0.1' }], { client, now: NOW });
    const m = hints.find((h) => h.code === 'maintainer_change');
    expect(m?.code === 'maintainer_change' && m.detail.kind).toBe('new_publisher');
    expect(m?.level).toBe('error');
  });

  it('flags a dormant maintainer returning after a long gap', async () => {
    setTopPackagesForTest([]);
    const client = registryOf({
      dorm: {
        name: 'dorm',
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': { _npmUser: { name: 'carol', email: 'carol@good.dev' } },
          '2.0.0': { _npmUser: { name: 'carol', email: 'carol@good.dev' } },
        },
        time: { created: TWO_YEARS_AGO, '1.0.0': TWO_YEARS_AGO, '2.0.0': '2026-06-01T00:00:00.000Z' },
      },
    });
    const hints = await collectRiskHints([{ name: 'dorm', spec: '2.0.0' }], { client, now: NOW });
    const m = hints.find((h) => h.code === 'maintainer_change');
    expect(m?.code === 'maintainer_change' && m.detail.kind).toBe('dormant');
  });
});

describe('missing-metadata signal', () => {
  it('flags a package missing repository and license', async () => {
    setTopPackagesForTest([]);
    const client = registryOf({ bare: { name: 'bare', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} }, time: { created: LONG_AGO, '1.0.0': LONG_AGO } } });
    const hints = await collectRiskHints([{ name: 'bare', spec: '1.0.0' }], { client, now: NOW });
    const meta = hints.find((h) => h.code === 'missing_metadata');
    expect(meta?.code === 'missing_metadata' && meta.detail.missing).toEqual(['repository', 'license']);
  });

  it('does not flag a package that has both', async () => {
    setTopPackagesForTest([]);
    const client = registryOf({
      full: { name: 'full', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { repository: { url: 'git+https://x' }, license: 'MIT' } }, time: { created: LONG_AGO, '1.0.0': LONG_AGO } },
    });
    const hints = await collectRiskHints([{ name: 'full', spec: '1.0.0' }], { client, now: NOW });
    expect(hints.some((h) => h.code === 'missing_metadata')).toBe(false);
  });
});

/** Build a resolved target carrying just the packument bits a signal reads. */
function target(name: string, maintainerEmail: string): ResolvedTarget {
  return {
    name,
    spec: '',
    version: '1.0.0',
    manifest: {},
    packument: { name, versions: { '1.0.0': {} }, maintainers: [{ name: 'm', email: maintainerEmail }] },
  };
}

describe('expired-domain signal (DNS)', () => {
  const resolver: NsResolver = {
    async resolveNs(domain: string) {
      if (domain === 'gone.example') {
        const e = new Error('not found') as NodeJS.ErrnoException;
        e.code = 'ENOTFOUND';
        throw e;
      }
      if (domain === 'slow.example') {
        const e = new Error('timeout') as NodeJS.ErrnoException;
        e.code = 'ETIMEDOUT';
        throw e;
      }
      return ['ns1.dns.example'];
    },
  };

  it('flags a package whose maintainer domain no longer resolves', async () => {
    const hints = await expiredDomainHints([target('a', 'x@gone.example')], { resolver });
    expect(hints).toHaveLength(1);
    expect(hints[0]?.code === 'expired_domain' && hints[0].detail.domain).toBe('gone.example');
  });

  it('does not flag a resolvable domain', async () => {
    const hints = await expiredDomainHints([target('b', 'y@good.example')], { resolver });
    expect(hints).toHaveLength(0);
  });

  it('fails open on an inconclusive DNS error (timeout → no hint)', async () => {
    const hints = await expiredDomainHints([target('c', 'z@slow.example')], { resolver });
    expect(hints).toHaveLength(0);
  });
});

describe('defaultNsResolver', () => {
  const KEY = 'SCREEN_DNS_SERVERS';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('uses the system resolver by default (no fixed public servers forced)', () => {
    delete process.env[KEY];
    const servers = defaultNsResolver(1000).getServers();
    // We don't pin specific system servers, but we must NOT have forced 1.1.1.1/8.8.8.8.
    expect(servers).not.toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('honours SCREEN_DNS_SERVERS override', () => {
    process.env[KEY] = '9.9.9.9, 149.112.112.112';
    const servers = defaultNsResolver(1000).getServers();
    expect(servers.some((s) => s.startsWith('9.9.9.9'))).toBe(true);
  });

  it('falls back to the system resolver on an invalid override (does not throw or disable)', () => {
    process.env[KEY] = 'not-an-ip';
    expect(() => defaultNsResolver(1000)).not.toThrow();
    expect(defaultNsResolver(1000).getServers()).not.toContain('not-an-ip');
  });
});

describe('low-downloads signal', () => {
  const client: DownloadsClient = {
    async lastMonth(name: string) {
      return ({ tiny: 5, huge: 1_000_000 } as Record<string, number | undefined>)[name];
    },
  };

  it('flags a package with very low monthly downloads', async () => {
    const hints = await lowDownloadHints([target('tiny', 'm@x.dev')], { client, threshold: 50 });
    expect(hints[0]?.code === 'low_downloads' && hints[0].detail.downloads).toBe(5);
  });

  it('does not flag a popular package', async () => {
    const hints = await lowDownloadHints([target('huge', 'm@x.dev')], { client, threshold: 50 });
    expect(hints).toHaveLength(0);
  });

  it('fails open when the download count is unknown', async () => {
    const hints = await lowDownloadHints([target('unknown', 'm@x.dev')], { client, threshold: 50 });
    expect(hints).toHaveLength(0);
  });

  it('downloads client skips scoped packages (point API limitation)', async () => {
    const dl = createDownloadsClient((async () => {
      throw new Error('should not be called for scoped');
    }) as unknown as typeof fetch);
    expect(await dl.lastMonth('@scope/pkg')).toBeUndefined();
  });
});
