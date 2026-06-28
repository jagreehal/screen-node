import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disabledByEnv, isNewerVersion, refreshUpdateCache, updateBanner } from '../src/update-check.js';

describe('isNewerVersion', () => {
  it('compares x.y.z numerically (not lexically)', () => {
    expect(isNewerVersion('1.2.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true); // would fail under string compare
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.2.0')).toBe(false);
  });

  it('ignores prerelease/build metadata and returns false on unparseable input', () => {
    expect(isNewerVersion('1.2.0-beta.1', '1.2.0')).toBe(false); // same x.y.z
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'garbage')).toBe(false);
  });
});

describe('disabledByEnv', () => {
  it('honours CI, NO_UPDATE_NOTIFIER, and the sandbox-specific switch', () => {
    expect(disabledByEnv({})).toBe(false);
    expect(disabledByEnv({ CI: 'true' })).toBe(true);
    expect(disabledByEnv({ NO_UPDATE_NOTIFIER: '1' })).toBe(true);
    expect(disabledByEnv({ SANDBOX_NO_UPDATE_CHECK: '1' })).toBe(true);
  });
});

describe('updateBanner', () => {
  it('renders a notice only when the cached latest is strictly newer', () => {
    expect(updateBanner('1.0.0', { lastCheckMs: 0, latest: '1.2.0' })).toContain('1.0.0 → 1.2.0');
    expect(updateBanner('1.0.0', { lastCheckMs: 0, latest: '1.2.0' })).toContain('npm i -g @jagreehal/screen-node');
    expect(updateBanner('1.0.0', { lastCheckMs: 0, latest: '1.0.0' })).toBeUndefined();
    expect(updateBanner('2.0.0', { lastCheckMs: 0, latest: '1.2.0' })).toBeUndefined();
    expect(updateBanner('1.0.0', { lastCheckMs: 0 })).toBeUndefined(); // never checked yet
  });
});

describe('refreshUpdateCache', () => {
  const prevXdg = process.env.XDG_CACHE_HOME;
  beforeEach(() => {
    process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), 'sbx-upd-'));
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevXdg;
  });

  it('writes the registry latest so the next run can show a banner', async () => {
    const client = { getPackument: async () => ({ 'dist-tags': { latest: '9.9.9' }, versions: {} }) as never };
    await refreshUpdateCache(client, 1_000);
    // the cache the background process just wrote drives the banner shown on the following invocation
    expect(updateBanner('1.0.0')).toContain('1.0.0 → 9.9.9');
  });

  it('swallows a registry failure (offline must never surface) and keeps any prior latest', async () => {
    const ok = { getPackument: async () => ({ 'dist-tags': { latest: '3.0.0' }, versions: {} }) as never };
    await refreshUpdateCache(ok, 1_000);
    const boom = { getPackument: async () => { throw new Error('ENOTFOUND registry.npmjs.org'); } };
    await expect(refreshUpdateCache(boom, 2_000)).resolves.toBeUndefined();
    expect(updateBanner('1.0.0')).toContain('1.0.0 → 3.0.0'); // prior latest preserved
  });
});
