import { describe, expect, it } from 'vitest';
import { autoFixActions, doctorExitCode, doctorSummary, type Check } from '../src/doctor.js';

const ok = (label: string): Check => ({ level: 'ok', label, detail: 'fine' });

describe('autoFixActions', () => {
  it('is empty when every check passes', () => {
    expect(autoFixActions([ok('config'), ok('backend'), ok('image')])).toEqual([]);
  });

  it('returns a build action for an absent or stale image', () => {
    const checks: Check[] = [
      ok('backend'),
      { level: 'info', label: 'image', detail: 'present but out of date', autoFix: 'build' },
    ];
    expect(autoFixActions(checks)).toEqual(['build']);
  });

  it('does not try to auto-fix a non-automatable failure (e.g. a down daemon)', () => {
    const checks: Check[] = [
      { level: 'fail', label: 'daemon', detail: 'not reachable', fixes: ['open -a Docker'] },
    ];
    expect(autoFixActions(checks)).toEqual([]);
  });

  it('deduplicates so a single build runs even if several checks request it', () => {
    const checks: Check[] = [
      { level: 'info', label: 'image', detail: 'absent', autoFix: 'build' },
      { level: 'info', label: 'image', detail: 'stale', autoFix: 'build' },
    ];
    expect(autoFixActions(checks)).toEqual(['build']);
  });
});

describe('doctorExitCode', () => {
  it('is 0 when only ok/info checks are present (e.g. a missing config file uses defaults)', () => {
    const checks: Check[] = [
      { level: 'info', label: 'config', detail: 'no config file, using defaults' },
      ok('backend'),
      ok('daemon'),
      { level: 'info', label: 'image', detail: 'will build on first use', autoFix: 'build' },
    ];
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('is 1 when any check failed (a down daemon, a missing backend, a malformed config)', () => {
    expect(doctorExitCode([ok('config'), { level: 'fail', label: 'daemon', detail: 'not reachable' }])).toBe(1);
  });
});

describe('doctorSummary', () => {
  it('gives an all-clear verdict with the next commands when nothing failed (info is fine)', () => {
    const summary = doctorSummary([ok('backend'), { level: 'info', label: 'image', detail: 'will build on first use' }]);
    expect(summary).toContain('[ok]');
    expect(summary).toContain('sandbox install');
  });

  it('counts failures and points back at the report', () => {
    expect(doctorSummary([ok('config'), { level: 'fail', label: 'daemon', detail: 'down' }])).toBe(
      '[fail] 1 check needs attention, fix the above, then rerun: sandbox doctor',
    );
    expect(doctorSummary([{ level: 'fail', label: 'backend', detail: 'x' }, { level: 'fail', label: 'daemon', detail: 'y' }])).toContain('2 checks need attention');
  });
});
