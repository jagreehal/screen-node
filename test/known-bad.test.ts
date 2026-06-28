import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFeedCache, matchKnownBad, parseAdvisoryFile, parseFeed, updateFeeds, type KnownBadEntry } from '../src/known-bad.js';

const NOW = new Date('2026-06-13T00:00:00.000Z');

describe('parseAdvisoryFile', () => {
  it('accepts a top-level array and { advisories: [...] }, with optional fields', () => {
    const arr = parseAdvisoryFile('[{"name":"evil"},{"name":"bad","versions":["1.0.0"],"reason":"compromised","severity":"high"}]', 'a.json');
    expect(arr).toEqual([
      { name: 'evil', versions: undefined, reason: undefined, severity: undefined, source: 'a.json' },
      { name: 'bad', versions: ['1.0.0'], reason: 'compromised', severity: 'high', source: 'a.json' },
    ]);
    const wrapped = parseAdvisoryFile('{ "advisories": [ {"name":"x"} ] }', 'b.json');
    expect(wrapped.map((e) => e.name)).toEqual(['x']);
  });

  it('tolerates JSONC comments and ignores an unknown severity', () => {
    const arr = parseAdvisoryFile('[\n  // block this\n  {"name":"foo","severity":"bogus"}\n]', 'c.json');
    expect(arr[0]).toMatchObject({ name: 'foo', severity: undefined });
  });

  it('treats a "*" version as every version', () => {
    const arr = parseAdvisoryFile('[{"name":"foo","versions":["*"]}]', 'w.json');
    expect(arr[0]!.versions).toBeUndefined();
  });

  it('throws on a missing name or wrong shape (a typo must fail loudly)', () => {
    expect(() => parseAdvisoryFile('[{"reason":"no name"}]', 'd.json')).toThrow(/non-empty "name"/);
    expect(() => parseAdvisoryFile('{"nope":1}', 'e.json')).toThrow(/array of advisories/);
  });
});

describe('matchKnownBad', () => {
  const entries: KnownBadEntry[] = [
    { name: 'evil', source: 'feed' }, // all versions
    { name: 'partly', versions: ['1.0.0', '1.0.1'], reason: 'two bad cuts', severity: 'medium', source: 'team' },
  ];

  it('blocks every version for a name-only entry', () => {
    const hits = matchKnownBad([{ name: 'evil', version: '9.9.9' }], entries);
    expect(hits).toEqual([{ name: 'evil', version: '9.9.9', reason: 'listed as known-bad', severity: 'critical', source: 'feed' }]);
  });

  it('blocks only the listed versions for a version-scoped entry', () => {
    expect(matchKnownBad([{ name: 'partly', version: '1.0.0' }], entries)).toHaveLength(1);
    expect(matchKnownBad([{ name: 'partly', version: '2.0.0' }], entries)).toHaveLength(0);
  });

  it('ignores unlisted packages and de-duplicates name@version', () => {
    expect(matchKnownBad([{ name: 'fine', version: '1.0.0' }], entries)).toHaveLength(0);
    const dup = matchKnownBad([{ name: 'evil', version: '1.0.0' }, { name: 'evil', version: '1.0.0' }], entries);
    expect(dup).toHaveLength(1);
  });
});

describe('parseFeed', () => {
  it('parses a JSON array of names', () => {
    expect(parseFeed('["a", "b"]')).toEqual([{ name: 'a' }, { name: 'b' }]);
  });
  it('parses a JSON array of {name,version} and a {packages:[...]} wrapper', () => {
    expect(parseFeed('[{"name":"a","version":"1.0.0"}]')).toEqual([{ name: 'a', version: '1.0.0' }]);
    expect(parseFeed('{"packages":[{"name":"b"}]}')).toEqual([{ name: 'b' }]);
  });
  it('parses CSV/newline rows and skips a header + comments', () => {
    expect(parseFeed('name,version\nfoo,1.0.0\n# note\nbar')).toEqual([{ name: 'foo', version: '1.0.0' }, { name: 'bar', version: undefined }]);
  });

  it("parses Aikido's actual shape (package_name + reason)", () => {
    expect(parseFeed('[{"package_name":"evil-pkg","version":"1.0.0","reason":"MALWARE"}]')).toEqual([
      { name: 'evil-pkg', version: '1.0.0', reason: 'MALWARE' },
    ]);
  });
});

describe('updateFeeds + loadFeedCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sbx-feeds-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fakeFetch = (body: Record<string, string>): typeof fetch =>
    (async (url: string | URL | Request) => {
      const key = String(url);
      if (!(key in body)) return { ok: false, status: 404, async text() { return ''; } } as Response;
      return { ok: true, status: 200, async text() { return body[key]!; } } as Response;
    }) as typeof fetch;

  it('fetches, caches, and the cache loads back as critical known-bad entries', async () => {
    const fetchImpl = fakeFetch({ 'https://feed/a': '["mal-a"]', 'https://feed/b': '[{"name":"mal-b","version":"2.0.0"}]' });
    const res = await updateFeeds(['https://feed/a', 'https://feed/b'], { fetchImpl, cacheDir: dir, now: NOW });
    expect(res).toEqual([{ feed: 'https://feed/a', count: 1 }, { feed: 'https://feed/b', count: 1 }]);

    const entries = loadFeedCache(dir);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mal-a', versions: undefined, severity: 'critical', source: 'https://feed/a' }),
      expect.objectContaining({ name: 'mal-b', versions: ['2.0.0'], severity: 'critical', source: 'https://feed/b' }),
    ]));
  });

  it('caches an Aikido-shaped feed and carries its reason into the known-bad entry', async () => {
    const fetchImpl = fakeFetch({ 'https://aikido': '[{"package_name":"evil","version":"6.6.6","reason":"MALWARE"}]' });
    await updateFeeds(['https://aikido'], { fetchImpl, cacheDir: dir, now: NOW });
    const entry = loadFeedCache(dir).find((e) => e.name === 'evil');
    expect(entry).toMatchObject({ name: 'evil', versions: ['6.6.6'], severity: 'critical', reason: 'MALWARE (malware feed)' });
  });

  it('records a per-feed error without aborting the rest', async () => {
    const fetchImpl = fakeFetch({ 'https://feed/ok': '["x"]' });
    const res = await updateFeeds(['https://feed/dead', 'https://feed/ok'], { fetchImpl, cacheDir: dir, now: NOW });
    expect(res[0]).toMatchObject({ feed: 'https://feed/dead', count: 0 });
    expect(res[0]!.error).toBeTruthy();
    expect(res[1]).toEqual({ feed: 'https://feed/ok', count: 1 });
  });

  it('prunes cache files for feeds no longer configured', async () => {
    const fetchImpl = fakeFetch({ 'https://feed/a': '["a"]', 'https://feed/b': '["b"]' });
    await updateFeeds(['https://feed/a', 'https://feed/b'], { fetchImpl, cacheDir: dir, now: NOW });
    expect(readdirSync(dir).length).toBe(2);
    await updateFeeds(['https://feed/a'], { fetchImpl, cacheDir: dir, now: NOW }); // dropped b
    expect(readdirSync(dir).length).toBe(1);
    expect(loadFeedCache(dir).map((e) => e.name)).toEqual(['a']);
  });

  it('skips a corrupt cache file rather than throwing', () => {
    writeFileSync(path.join(dir, 'junk.json'), '{not json');
    expect(loadFeedCache(dir)).toEqual([]);
  });
});
