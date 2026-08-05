import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCacheableFrozenInstall, isVetted, lockfileFingerprint, recordVetted, VETTED_TTL_MS, type VettedPolicy } from '../src/vetted.js';

const NOW = new Date('2026-08-05T00:00:00Z');
const POLICY: VettedPolicy = { advisories: true, deep: false, minReleaseAgeDays: 3, knownBadCount: 0 };

let repo: string;
let cacheHome: string;
const originalCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'screen-vetted-repo-'));
  cacheHome = mkdtempSync(path.join(os.tmpdir(), 'screen-vetted-cache-'));
  process.env.XDG_CACHE_HOME = cacheHome;
  writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/zod': { version: '3.23.8' } } }));
});

afterEach(() => {
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
});

describe('lockfileFingerprint', () => {
  it('is stable for an unchanged lockfile and policy', () => {
    expect(lockfileFingerprint(repo, 'npm', POLICY)).toBe(lockfileFingerprint(repo, 'npm', POLICY));
  });

  // The core safety property: you cannot change a pinned dependency and keep a stale pass.
  it('changes when the lockfile content changes', () => {
    const before = lockfileFingerprint(repo, 'npm', POLICY);
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/zod': { version: '3.23.9' } } }));
    expect(lockfileFingerprint(repo, 'npm', POLICY)).not.toBe(before);
  });

  // A verdict reached under laxer gates must not satisfy a stricter run.
  it('changes when any gate setting changes', () => {
    const base = lockfileFingerprint(repo, 'npm', POLICY);
    expect(lockfileFingerprint(repo, 'npm', { ...POLICY, deep: true })).not.toBe(base);
    expect(lockfileFingerprint(repo, 'npm', { ...POLICY, minReleaseAgeDays: 7 })).not.toBe(base);
    expect(lockfileFingerprint(repo, 'npm', { ...POLICY, knownBadCount: 1 })).not.toBe(base);
    expect(lockfileFingerprint(repo, 'npm', { ...POLICY, advisories: false })).not.toBe(base);
  });

  it('is undefined without a lockfile, which disables the cache entirely', () => {
    expect(lockfileFingerprint(mkdtempSync(path.join(os.tmpdir(), 'screen-empty-')), 'npm', POLICY)).toBeUndefined();
  });
});

describe('isCacheableFrozenInstall', () => {
  it('only permits cache reuse for an actual frozen install route', () => {
    expect(isCacheableFrozenInstall('install', false, false, true)).toBe(true);
    expect(isCacheableFrozenInstall('install', false, true, false)).toBe(true);
    expect(isCacheableFrozenInstall('install', true, false, false)).toBe(true);
    expect(isCacheableFrozenInstall('install', false, false, false)).toBe(false);
    expect(isCacheableFrozenInstall('add', false, false, true)).toBe(false);
    expect(isCacheableFrozenInstall('update', false, true, false)).toBe(false);
  });
});

describe('isVetted / recordVetted', () => {
  it('reports a freshly recorded fingerprint as vetted', () => {
    const fp = lockfileFingerprint(repo, 'npm', POLICY);
    expect(isVetted(fp, NOW)).toBe(false); // nothing recorded yet
    recordVetted(fp, NOW);
    expect(isVetted(fp, NOW)).toBe(true);
  });

  // New advisories land continuously, so "clean yesterday" is not "clean now".
  it('expires an entry past the TTL', () => {
    const fp = lockfileFingerprint(repo, 'npm', POLICY);
    recordVetted(fp, NOW);
    expect(isVetted(fp, new Date(NOW.getTime() + VETTED_TTL_MS - 1000))).toBe(true);
    expect(isVetted(fp, new Date(NOW.getTime() + VETTED_TTL_MS + 1000))).toBe(false);
  });

  it('treats a backwards clock as not vetted rather than trusting it', () => {
    const fp = lockfileFingerprint(repo, 'npm', POLICY);
    recordVetted(fp, NOW);
    expect(isVetted(fp, new Date(NOW.getTime() - 60_000))).toBe(false);
  });

  it('does not vouch for a different lockfile', () => {
    const fp = lockfileFingerprint(repo, 'npm', POLICY);
    recordVetted(fp, NOW);
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/evil': { version: '9.9.9' } } }));
    expect(isVetted(lockfileFingerprint(repo, 'npm', POLICY), NOW)).toBe(false);
  });

  it('is a no-op for an undefined fingerprint (no lockfile means no cache)', () => {
    recordVetted(undefined, NOW);
    expect(isVetted(undefined, NOW)).toBe(false);
  });

  it('prunes expired entries on write so the file cannot grow without bound', () => {
    const fp = lockfileFingerprint(repo, 'npm', POLICY);
    recordVetted(fp, NOW);
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/zod': { version: '4.0.0' } } }));
    const later = new Date(NOW.getTime() + VETTED_TTL_MS + 1000);
    recordVetted(lockfileFingerprint(repo, 'npm', POLICY), later);
    // The first entry aged out and was dropped, so it cannot come back even if the lockfile reverts.
    expect(isVetted(fp, later)).toBe(false);
  });
});
