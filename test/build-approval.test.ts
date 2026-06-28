import { describe, expect, it } from 'vitest';
import { applyBuildApprovals, argvRunsPnpm, parsePendingBuilds, planBuildApproval, renderApproveBuildsCommand } from '../src/build-approval.js';

describe('argvRunsPnpm', () => {
  it('is true only when the command itself runs pnpm (bare or via corepack)', () => {
    expect(argvRunsPnpm(['pnpm', 'install'])).toBe(true);
    expect(argvRunsPnpm(['corepack', 'pnpm', 'install', '--frozen-lockfile'])).toBe(true);
    expect(argvRunsPnpm(['corepack', 'pnpm', 'remove', 'zod'])).toBe(true);
  });

  it('is false for other package managers, so build-approval stays pnpm-only', () => {
    // The cross-PM bug: `sandbox npm install` in a pnpm repo must NOT trip pnpm build-approval.
    expect(argvRunsPnpm(['npm', 'install'])).toBe(false);
    expect(argvRunsPnpm(['corepack', 'yarn', 'install'])).toBe(false);
    expect(argvRunsPnpm(['bun', 'install'])).toBe(false);
  });
});

describe('planBuildApproval', () => {
  const base = { pendingCount: 1, isPnpmInstall: true, allowAll: false, canPrompt: false };

  it('is none when there is nothing pending or it is not a pnpm install', () => {
    expect(planBuildApproval({ ...base, pendingCount: 0 })).toBe('none');
    expect(planBuildApproval({ ...base, isPnpmInstall: false })).toBe('none');
  });

  it('approve-all wins when --allow-all-builds is set (even with a TTY)', () => {
    expect(planBuildApproval({ ...base, allowAll: true })).toBe('approve-all');
    expect(planBuildApproval({ ...base, allowAll: true, canPrompt: true })).toBe('approve-all');
  });

  it('prompts when a TTY is available and no flag was passed', () => {
    expect(planBuildApproval({ ...base, canPrompt: true })).toBe('prompt');
  });

  it('falls back to guidance with no TTY and no flag (CI / non-interactive)', () => {
    expect(planBuildApproval({ ...base })).toBe('guide');
  });

  it('decides the same way regardless of native vs contained (the path does not change the decision)', () => {
    // The decision is mode-independent; only the copy differs. So native installs get the same UX.
    expect(planBuildApproval({ pendingCount: 2, isPnpmInstall: true, allowAll: false, canPrompt: true })).toBe('prompt');
  });
});

describe('parsePendingBuilds', () => {
  it('flags allowBuilds entries with pnpm’s placeholder value', () => {
    const text = `allowBuilds:
  esbuild: true
  protobufjs: set this to true or false
  sharp: false
`;
    expect(parsePendingBuilds(text)).toEqual(['protobufjs']);
  });

  it('returns nothing when every entry is decided', () => {
    const text = `allowBuilds:
  esbuild: true
  sharp: false
`;
    expect(parsePendingBuilds(text)).toEqual([]);
  });

  it('ignores entries outside the allowBuilds section', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
allowBuilds:
  protobufjs: set this to true or false
confirmModulesPurge: false
`;
    expect(parsePendingBuilds(text)).toEqual(['protobufjs']);
  });

  it('returns [] when there is no allowBuilds section', () => {
    expect(parsePendingBuilds('onlyBuiltDependencies:\n  - esbuild\n')).toEqual([]);
  });
});

describe('applyBuildApprovals', () => {
  it('approves: sets true and adds to onlyBuiltDependencies', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
allowBuilds:
  esbuild: true
  protobufjs: set this to true or false
`;
    const { text: out, allowed, denied } = applyBuildApprovals(text, new Map([['protobufjs', true]]));
    expect(allowed).toEqual(['protobufjs']);
    expect(denied).toEqual([]);
    expect(out).toContain('protobufjs: true');
    expect(out).not.toContain('set this to true or false');
    // added to the sequence section exactly once
    expect(out.match(/-\s+protobufjs/g)).toHaveLength(1);
  });

  it('denies: sets false and does NOT add to onlyBuiltDependencies', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
allowBuilds:
  protobufjs: set this to true or false
`;
    const { text: out, allowed, denied } = applyBuildApprovals(text, new Map([['protobufjs', false]]));
    expect(allowed).toEqual([]);
    expect(denied).toEqual(['protobufjs']);
    expect(out).toContain('protobufjs: false');
    expect(out).not.toMatch(/-\s+protobufjs/);
  });

  it('denies: removes a package already present in onlyBuiltDependencies', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
  - protobufjs
allowBuilds:
  protobufjs: true
`;
    const out = applyBuildApprovals(text, new Map([['protobufjs', false]])).text;
    expect(out).toContain('protobufjs: false');
    expect(out).not.toMatch(/-\s+protobufjs/);
    expect(out).toMatch(/-\s+esbuild/);
  });

  it('creates both sections when neither exists (pre-approving a named package)', () => {
    const out = applyBuildApprovals('', new Map([['protobufjs', true]])).text;
    expect(out).toContain('allowBuilds:');
    expect(out).toContain('protobufjs: true');
    expect(out).toContain('onlyBuiltDependencies:');
    expect(out).toMatch(/-\s+protobufjs/);
  });

  it('does not duplicate an onlyBuiltDependencies entry already present', () => {
    const text = `onlyBuiltDependencies:
  - protobufjs
allowBuilds:
  protobufjs: set this to true or false
`;
    const out = applyBuildApprovals(text, new Map([['protobufjs', true]])).text;
    expect(out.match(/-\s+protobufjs/g)).toHaveLength(1);
  });
});

describe('renderApproveBuildsCommand', () => {
  it('renders a ready-to-run one-liner', () => {
    expect(renderApproveBuildsCommand(['protobufjs', 'esbuild'])).toBe('screen approve-builds protobufjs esbuild');
  });
});
