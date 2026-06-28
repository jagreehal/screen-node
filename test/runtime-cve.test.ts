import { describe, expect, it } from 'vitest';
import { nodeEolStatus, parseVersion, runtimeVulnerabilities } from '../src/runtime-cve.js';

describe('parseVersion', () => {
  it('extracts the first dotted version from common runtime strings', () => {
    expect(parseVersion('1.1.12')).toEqual([1, 1, 12]);
    expect(parseVersion('v1.1.12')).toEqual([1, 1, 12]);
    expect(parseVersion('Docker version 25.0.2, build abc')).toEqual([25, 0, 2]);
    expect(parseVersion('24.0.9-ce')).toEqual([24, 0, 9]);
    expect(parseVersion('1.1')).toEqual([1, 1, 0]);
  });

  it('returns undefined for non-version strings (e.g. a commit hash)', () => {
    expect(parseVersion('c241c0bb5e60a8e8c1b2e53d4eca8d0068d8d57e')).toBeUndefined();
    expect(parseVersion(undefined)).toBeUndefined();
  });
});

describe('runtimeVulnerabilities', () => {
  const ids = (i: { engine?: string; runc?: string }) => runtimeVulnerabilities(i).map((v) => v.id);

  it('flags Leaky Vessels on runc < 1.1.12', () => {
    expect(ids({ runc: '1.1.11' })).toContain('CVE-2024-21626');
    expect(ids({ runc: '1.1.12' })).not.toContain('CVE-2024-21626'); // exactly the fix
    expect(ids({ runc: '1.2.0' })).toEqual([]);
  });

  it('also flags the /proc/self/exe overwrite on ancient runc', () => {
    expect(ids({ runc: '0.1.1' })).toEqual(expect.arrayContaining(['CVE-2024-21626', 'CVE-2019-5736']));
  });

  it('falls back to the Docker engine version when runc is not a semver', () => {
    // runc reported as a commit hash -> use the engine version instead.
    expect(ids({ engine: 'Docker version 24.0.7, build x', runc: 'c241c0bb' })).toContain('CVE-2024-21626');
    expect(ids({ engine: 'Docker version 24.0.9, build x', runc: 'c241c0bb' })).toEqual([]); // backport fix
    expect(ids({ engine: 'Docker version 25.0.2, build x' })).toEqual([]);
    expect(ids({ engine: 'Docker version 29.4.0, build x' })).toEqual([]); // current
    expect(ids({ engine: 'Docker version 25.0.1, build x' })).toContain('CVE-2024-21626');
  });

  it('reports nothing when neither version can be determined', () => {
    expect(runtimeVulnerabilities({})).toEqual([]);
    expect(runtimeVulnerabilities({ runc: 'deadbeef' })).toEqual([]);
  });
});

describe('nodeEolStatus', () => {
  const now = new Date('2026-06-13T00:00:00.000Z');

  it('marks a line past its EOL date as eol', () => {
    expect(nodeEolStatus(18, now)).toMatchObject({ status: 'eol', eol: '2025-04-30' });
    expect(nodeEolStatus(20, now)).toMatchObject({ status: 'eol', eol: '2026-04-30' }); // EOL just passed
  });

  it('marks a still-maintained line as active', () => {
    expect(nodeEolStatus(22, now)).toMatchObject({ status: 'active', eol: '2027-04-30' });
    expect(nodeEolStatus(24, now)).toMatchObject({ status: 'active' });
  });

  it('returns unknown for a major not in the table (odd/pre-release)', () => {
    expect(nodeEolStatus(23, now)).toEqual({ major: 23, status: 'unknown' });
  });
});
