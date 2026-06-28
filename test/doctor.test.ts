import { describe, expect, it } from 'vitest';
import { doctorExitCode, doctorSummary, type Check } from '../src/doctor.js';

const ok = (label: string): Check => ({ level: 'ok', label, detail: 'fine' });

describe('doctorExitCode', () => {
  it('is 0 when only ok/info checks are present (e.g. a missing config file uses defaults)', () => {
    const checks: Check[] = [
      { level: 'info', label: 'config', detail: 'no config file, using defaults' },
      ok('package manager'),
      ok('node runtime'),
    ];
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('is 1 when any check failed (a malformed config)', () => {
    expect(doctorExitCode([ok('package manager'), { level: 'fail', label: 'config', detail: 'invalid' }])).toBe(1);
  });
});

describe('doctorSummary', () => {
  it('gives an all-clear verdict with the next command when nothing failed (info is fine)', () => {
    const summary = doctorSummary([ok('package manager'), { level: 'info', label: 'config', detail: 'using defaults' }]);
    expect(summary).toContain('[ok]');
    expect(summary).toContain('screen install');
  });

  it('counts failures and points back at the report', () => {
    expect(doctorSummary([ok('config'), { level: 'fail', label: 'config', detail: 'bad' }])).toBe(
      '[fail] 1 check needs attention, fix the above, then rerun: screen doctor',
    );
    expect(doctorSummary([{ level: 'fail', label: 'config', detail: 'x' }, { level: 'fail', label: 'package manager', detail: 'y' }])).toContain('2 checks need attention');
  });
});
