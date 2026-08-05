import { describe, expect, it } from 'vitest';
import { collectTrustCandidates, DEFAULT_TRUSTED_BUILDS, explainRejection, judgeTrust, partitionTrust, type TrustCandidate } from '../src/default-trust.js';

const NOW = new Date('2026-08-05T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A candidate that clears every gate, so each test can knock out exactly one. */
const ok = (over: Partial<TrustCandidate> = {}): TrustCandidate => ({
  name: 'esbuild',
  version: '0.21.5',
  publishedAt: new Date(NOW.getTime() - 30 * DAY),
  fromRegistry: true,
  inLockfile: true,
  advisoryHit: false,
  advisoryChecked: true,
  ...over,
});

describe('judgeTrust, the floor that decides whether a build script skips the human', () => {
  it('clears a curated package that passes provenance, advisory, and cooling', () => {
    expect(judgeTrust(ok(), { now: NOW })).toEqual({ name: 'esbuild', trusted: true });
  });

  it('never trusts a package outside the curated list, however clean it looks', () => {
    expect(judgeTrust(ok({ name: 'some-random-pkg' }), { now: NOW })).toMatchObject({ trusted: false, reason: 'not-curated' });
  });

  // The provenance gate. An alias or git dep can't borrow a curated name's trust — that substitution
  // is the whole attack this gate exists to stop.
  it('refuses a curated name that did not resolve from the registry', () => {
    expect(judgeTrust(ok({ fromRegistry: false }), { now: NOW })).toMatchObject({ trusted: false, reason: 'not-registry' });
    expect(judgeTrust(ok({ version: undefined }), { now: NOW })).toMatchObject({ trusted: false, reason: 'not-registry' });
  });

  it('refuses a version with a malware advisory', () => {
    expect(judgeTrust(ok({ advisoryHit: true }), { now: NOW })).toMatchObject({ trusted: false, reason: 'advisory' });
  });

  // Fails CLOSED where the install path fails open: skipping a human needs a positive vouch, and an
  // OSV outage is the absence of one, not a pass.
  it('refuses when the advisory lookup could not run at all', () => {
    expect(judgeTrust(ok({ advisoryChecked: false }), { now: NOW })).toMatchObject({ trusted: false, reason: 'unchecked' });
  });

  it('refuses a version published inside the cooling window', () => {
    expect(judgeTrust(ok({ publishedAt: new Date(NOW.getTime() - 60 * 1000) }), { now: NOW })).toMatchObject({ trusted: false, reason: 'too-new' });
  });

  it('fails closed when the publish time is unknown (cannot evaluate the window)', () => {
    expect(judgeTrust(ok({ publishedAt: undefined }), { now: NOW })).toMatchObject({ trusted: false, reason: 'unknown-age' });
  });

  // Consenting to INSTALL a fresh version is a smaller decision than consenting to EXECUTE it
  // unattended, so the floor keeps its own 24h floor even when the install gate is off.
  it('applies its own cooling window even when the install-path age gate is disabled', () => {
    const fresh = ok({ publishedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) });
    expect(judgeTrust(fresh, { now: NOW, minAgeMs: 0 })).toMatchObject({ trusted: false, reason: 'too-new' });
  });

  it('honours a LONGER configured window over its own floor', () => {
    const week = ok({ publishedAt: new Date(NOW.getTime() - 3 * DAY) });
    expect(judgeTrust(week, { now: NOW })).toMatchObject({ trusted: true });
    expect(judgeTrust(week, { now: NOW, minAgeMs: 7 * DAY })).toMatchObject({ trusted: false, reason: 'too-new' });
  });
});

describe('the curated list itself', () => {
  // Guards the mistake the module doc warns about: reusing data/top-packages.json (a typosquat corpus
  // of names attackers MIMIC) as a trust list. It should stay small enough to review by eye.
  it('is short and hand-reviewable, not a popularity dump', () => {
    expect(DEFAULT_TRUSTED_BUILDS.length).toBeLessThan(50);
  });

  it('has no duplicates', () => {
    expect(new Set(DEFAULT_TRUSTED_BUILDS).size).toBe(DEFAULT_TRUSTED_BUILDS.length);
  });
});

describe('partitionTrust', () => {
  it('splits the auto-approved from what still needs a human', () => {
    const { trusted, remaining } = partitionTrust([ok(), ok({ name: 'sharp' }), ok({ name: 'sketchy-pkg' })], { now: NOW });
    expect(trusted).toEqual(['esbuild', 'sharp']);
    expect(remaining.map((v) => v.name)).toEqual(['sketchy-pkg']);
  });
});

describe('explainRejection', () => {
  it('stays silent for the ordinary uncurated case, and explains the surprising ones', () => {
    expect(explainRejection('not-curated')).toBeUndefined();
    expect(explainRejection('advisory')).toContain('malware');
    expect(explainRejection('too-new')).toContain('worm window');
  });
});

describe('collectTrustCandidates', () => {
  const registry = { getPackument: async () => ({ name: 'esbuild', versions: { '0.21.5': {} }, time: { '0.21.5': new Date(NOW.getTime() - 30 * DAY).toISOString() } }) } as never;
  const noAdvisories = { query: async () => [] };

  it('makes zero network calls when nothing pending is curated', async () => {
    let calls = 0;
    const counting = { getPackument: async () => { calls++; return { name: 'x', versions: {} }; } } as never;
    const got = await collectTrustCandidates(['my-app-tool', 'internal-thing'], { lockfilePackages: () => [], registry: counting, advisory: noAdvisories });
    expect(calls).toBe(0);
    expect(got.every((c) => !c.fromRegistry)).toBe(true);
  });

  it('resolves the LOCKFILE version, not the range, and marks it registry-resolved', async () => {
    const got = await collectTrustCandidates(['esbuild'], {
      lockfilePackages: () => [{ name: 'esbuild', version: '0.21.5' }],
      registry,
      advisory: noAdvisories,
    });
    expect(got[0]).toMatchObject({ name: 'esbuild', version: '0.21.5', fromRegistry: true, advisoryChecked: true, advisoryHit: false });
    expect(judgeTrust(got[0]!, { now: NOW }).trusted).toBe(true);
  });

  // Regression: this is the shape a wrong package-manager guess produces (looking for the wrong
  // lockfile finds nothing). It must read as "nothing to check", never as "not from the registry".
  it('leaves a curated package untrusted, and says WHY, when the lockfile has no entry for it', async () => {
    const got = await collectTrustCandidates(['esbuild'], { lockfilePackages: () => [], registry, advisory: noAdvisories });
    expect(got[0]).toMatchObject({ fromRegistry: false, inLockfile: false });
    expect(judgeTrust(got[0]!, { now: NOW })).toMatchObject({ trusted: false, reason: 'no-lockfile-entry' });
  });

  it('does not auto-approve a package-name-wide decision when the tree has multiple versions', async () => {
    const got = await collectTrustCandidates(['esbuild'], {
      lockfilePackages: () => [
        { name: 'esbuild', version: '0.20.2' },
        { name: 'esbuild', version: '0.21.5' },
      ],
      registry,
      advisory: noAdvisories,
    });
    expect(got[0]).toMatchObject({ inLockfile: true, multipleVersions: true });
    expect(judgeTrust(got[0]!, { now: NOW })).toMatchObject({ trusted: false, reason: 'multiple-versions' });
  });

  // The outage path: a thrown lookup must degrade to "needs a human", never to an error or a pass.
  it('degrades to untrusted when the registry throws', async () => {
    const broken = { getPackument: async () => { throw new Error('ENOTFOUND'); } } as never;
    const got = await collectTrustCandidates(['esbuild'], {
      lockfilePackages: () => [{ name: 'esbuild', version: '0.21.5' }],
      registry: broken,
      advisory: noAdvisories,
    });
    expect(got[0]).toMatchObject({ fromRegistry: false, inLockfile: true, advisoryChecked: false });
    expect(judgeTrust(got[0]!, { now: NOW })).toMatchObject({ trusted: false, reason: 'not-registry' });
  });

  it('records a malware hit so the floor refuses it', async () => {
    const got = await collectTrustCandidates(['esbuild'], {
      lockfilePackages: () => [{ name: 'esbuild', version: '0.21.5' }],
      registry,
      advisory: { query: async () => ['MAL-2026-1234'] },
    });
    expect(got[0]).toMatchObject({ advisoryHit: true });
    expect(judgeTrust(got[0]!, { now: NOW })).toMatchObject({ trusted: false, reason: 'advisory' });
  });
});
