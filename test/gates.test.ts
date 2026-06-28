import { describe, expect, it } from 'vitest';
import { blockExit, deprecatedHints, nothingToCheck, type ActivePolicy } from '../src/gates.js';
import type { PreflightResult } from '../src/preflight.js';
import type { RiskHint } from '../src/risk.js';

// RiskHint is a discriminated union (code ↔ detail), so build each variant concretely. blockExit and
// deprecatedHints only read `code` (and hint count), so the detail payloads are minimal-but-valid.
const riskHint = (pkg = 'zod'): RiskHint => ({ level: 'warn', code: 'recent_version', package: pkg, message: 'x', detail: { publishedAt: '', severity: 'light' } });
const deprecatedHint = (pkg = 'old'): RiskHint => ({ level: 'warn', code: 'deprecated', package: pkg, message: 'no longer maintained', detail: { deprecated: 'no longer maintained' } });

const result = (over: Partial<PreflightResult> = {}): PreflightResult => ({
  hints: [],
  ageViolations: [],
  advisoryHits: [],
  knownBadHits: [],
  checkedCount: 0,
  ...over,
});

const ap = (over: Partial<ActivePolicy> = {}): ActivePolicy => ({
  riskHints: true,
  minReleaseAgeDays: 0,
  failOnAdvisory: false,
  failOnDeprecated: false,
  failOnRisk: false,
  deep: false,
  policy: { riskHints: true, thorough: false, minReleaseAgeDays: 0, releaseAgeExclude: [], deep: false, advisories: false },
  ...over,
});

describe('blockExit, the decision that lets a bad dependency land or not', () => {
  it('passes a clean result (nothing to block)', () => {
    expect(blockExit(result(), ap())).toBeUndefined();
  });

  it('ALWAYS blocks a known-bad hit (team blocklist / malware feed), regardless of flags', () => {
    const r = result({ knownBadHits: [{ name: 'evil', version: '1.0.0', reason: 'malware', severity: 'high', source: 'feed' }] });
    expect(blockExit(r, ap({ failOnRisk: false, failOnAdvisory: false, failOnDeprecated: false }))).toBe(1);
  });

  it('ALWAYS blocks a release-age violation (worm window), no opt-out', () => {
    const r = result({ ageViolations: [{ name: 'fresh', version: '9.9.9', publishedAt: new Date(0), ageMs: 1 }] });
    expect(blockExit(r, ap())).toBe(1);
  });

  it('ALWAYS blocks an OSV malware advisory, even when failOnAdvisory is off', () => {
    const r = result({ advisoryHits: [{ name: 'bad', version: '1.0.0', ids: ['MAL-123'], malware: true }] });
    expect(blockExit(r, ap({ failOnAdvisory: false }))).toBe(1);
  });

  it('does NOT block a non-malware advisory by malware-rule alone (that path is gated elsewhere)', () => {
    const r = result({ advisoryHits: [{ name: 'cve', version: '1.0.0', ids: ['CVE-1'], malware: false }] });
    expect(blockExit(r, ap())).toBeUndefined();
  });

  it('blocks a deprecated version only when failOnDeprecated is set', () => {
    const r = result({ hints: [deprecatedHint()] });
    expect(blockExit(r, ap({ failOnDeprecated: false }))).toBeUndefined();
    expect(blockExit(r, ap({ failOnDeprecated: true }))).toBe(1);
  });

  it('blocks any risk hint only under --fail-on-risk (and only while risk display is on)', () => {
    const r = result({ hints: [riskHint()] });
    expect(blockExit(r, ap({ failOnRisk: false }))).toBeUndefined();
    expect(blockExit(r, ap({ failOnRisk: true, riskHints: true }))).toBe(1);
    expect(blockExit(r, ap({ failOnRisk: true, riskHints: false }))).toBeUndefined(); // --risk off suppresses
  });
});

describe('nothingToCheck', () => {
  it('is true only when no gate would resolve the registry', () => {
    expect(nothingToCheck(ap({ riskHints: false, minReleaseAgeDays: 0, policy: { ...ap().policy, advisories: false } }))).toBe(true);
  });

  it('is false when any gate is active', () => {
    expect(nothingToCheck(ap({ riskHints: true }))).toBe(false);
    expect(nothingToCheck(ap({ riskHints: false, minReleaseAgeDays: 7 }))).toBe(false);
    expect(nothingToCheck(ap({ riskHints: false, policy: { ...ap().policy, advisories: true } }))).toBe(false);
  });
});

describe('deprecatedHints', () => {
  it('selects only the deprecated-coded hints', () => {
    const r = result({ hints: [deprecatedHint('a'), riskHint('b'), deprecatedHint('c')] });
    expect(deprecatedHints(r).map((h) => h.package)).toEqual(['a', 'c']);
  });
});
