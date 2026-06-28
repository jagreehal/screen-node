import { describe, expect, it } from 'vitest';
import { foldBinLeader, leaderForBin } from '../src/native.js';

describe('leaderForBin', () => {
  it('maps each screen-<pm> bin to its package-manager/runner leader', () => {
    expect(leaderForBin('screen-npm')).toBe('npm');
    expect(leaderForBin('screen-pnpm')).toBe('pnpm');
    expect(leaderForBin('screen-yarn')).toBe('yarn');
    expect(leaderForBin('screen-bun')).toBe('bun');
    expect(leaderForBin('screen-npx')).toBe('npx');
    expect(leaderForBin('screen-bunx')).toBe('bunx');
  });

  it('maps the terse s<pm> aliases too (muscle memory)', () => {
    expect(leaderForBin('snpm')).toBe('npm');
    expect(leaderForBin('spnpm')).toBe('pnpm');
    expect(leaderForBin('syarn')).toBe('yarn');
    expect(leaderForBin('sbun')).toBe('bun');
    expect(leaderForBin('snpx')).toBe('npx');
    expect(leaderForBin('sbunx')).toBe('bunx');
  });

  it('returns undefined for the plain bins and the from-source entry (normal dispatch)', () => {
    expect(leaderForBin('screen')).toBeUndefined();
    expect(leaderForBin('screen-node')).toBeUndefined();
    expect(leaderForBin('cli.ts')).toBeUndefined();
    expect(leaderForBin('cli.mjs')).toBeUndefined();
  });

  it('tolerates Windows shim suffixes', () => {
    expect(leaderForBin('screen-pnpm.cmd')).toBe('pnpm');
    expect(leaderForBin('screen-pnpm.mjs')).toBe('pnpm');
    expect(leaderForBin('screen-pnpm.ps1')).toBe('pnpm');
  });
});

describe('foldBinLeader', () => {
  it('folds the parsed command in as the leader\'s first argument (spnpm add zod -> pnpm add zod)', () => {
    expect(foldBinLeader('pnpm', { cmd: 'add', args: ['zod'] })).toEqual({ cmd: 'pnpm', args: ['add', 'zod'] });
  });

  it('keeps global flags after the folded command', () => {
    expect(foldBinLeader('npm', { cmd: 'install', args: ['--save-dev', 'vitest'] })).toEqual({ cmd: 'npm', args: ['install', '--save-dev', 'vitest'] });
  });

  it('handles a bare leader invocation with no parsed command (spnpm -> pnpm)', () => {
    expect(foldBinLeader('pnpm', { cmd: undefined, args: [] })).toEqual({ cmd: 'pnpm', args: [] });
  });

  it('passes the parse through unchanged for the plain screen bin (no leader)', () => {
    expect(foldBinLeader(undefined, { cmd: 'check', args: ['lodash'] })).toEqual({ cmd: 'check', args: ['lodash'] });
    expect(foldBinLeader(undefined, { cmd: undefined, args: [] })).toEqual({ cmd: undefined, args: [] });
  });
});
