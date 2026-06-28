import { describe, expect, it } from 'vitest';
import { classifyCommand, sourceWriteExit, summarizeUnexpectedChanges, wroteProjectLocalPnpmStore, type TreeSnapshot } from '../src/tamper.js';

function snap(files: Record<string, string>): TreeSnapshot {
  return { files: new Map(Object.entries(files)) };
}

describe('classifyCommand', () => {
  it('classifies install-class and add plans', () => {
    expect(classifyCommand(['npm', 'install'])).toBe('install');
    expect(classifyCommand(['corepack', 'pnpm', 'add', 'zod'])).toBe('add');
    expect(classifyCommand(['corepack', 'pnpm', 'up'])).toBe('install');
    expect(classifyCommand(['corepack', 'pnpm', 'audit', '--fix'])).toBe('install');
    expect(classifyCommand(['node', 'server.js'])).toBe('other');
  });
});

describe('sourceWriteExit, the writable-tree tripwire', () => {
  it('does nothing unless armed, even with source writes', () => {
    expect(sourceWriteExit(0, 3, false)).toBe(0);
  });

  it('fails an otherwise-clean run that wrote to the source tree, when armed', () => {
    expect(sourceWriteExit(0, 1, true)).toBe(1);
  });

  it('stays clean when armed but nothing was written', () => {
    expect(sourceWriteExit(0, 0, true)).toBe(0);
  });

  it('preserves an already-failing exit code (the source write is the lesser news)', () => {
    expect(sourceWriteExit(2, 5, true)).toBe(2);
  });
});

describe('summarizeUnexpectedChanges', () => {
  it('ignores expected lockfile and dependency output writes', () => {
    const before = snap({ 'package.json': 'a', 'src/index.ts': '1' });
    const after = snap({
      'package.json': 'a',
      'package-lock.json': 'new',
      'node_modules/is-number/package.json': 'x',
      'src/index.ts': '1',
    });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual([]);
  });

  it('reports source-tree tampering during install', () => {
    const before = snap({ 'package.json': 'a', 'src/index.ts': '1' });
    const after = snap({ 'package.json': 'a', 'src/index.ts': '2', 'src/persist.js': 'x' });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual(['src/index.ts', 'src/persist.js']);
  });

  it('allows package.json changes only for add', () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({ 'package.json': 'b' });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual(['package.json']);
    expect(summarizeUnexpectedChanges(before, after, 'add')).toEqual([]);
  });

  it('treats pnpm-workspace.yaml edits as expected install writes (allowBuilds / minimumReleaseAgeExclude)', () => {
    const before = snap({ 'package.json': 'a', 'pnpm-workspace.yaml': 'packages:\n' });
    const after = snap({ 'package.json': 'a', 'pnpm-workspace.yaml': 'packages:\nallowBuilds:\n  esbuild: true\n' });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual([]);
  });

  it("treats pnpm's project-local store as an expected install artifact", () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({
      'package.json': 'a',
      '.pnpm-store/v11/files/00/abc': 'x',
      '.pnpm-store/v11/files/01/def': 'y',
    });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual([]);
  });

  it('ignores nested workspace node_modules (monorepo install output)', () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({
      'package.json': 'a',
      'app/node_modules/.bin/tsx': 'x',
      'app/node_modules/hono/index.js': 'y',
      'packages/ui/node_modules/react/index.js': 'z',
    });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual([]);
  });

  it('still flags tampering that merely mentions node_modules in the path', () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({ 'package.json': 'a', 'src/node_modules_loader.ts': 'x' });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual(['src/node_modules_loader.ts']);
  });
});

describe('wroteProjectLocalPnpmStore', () => {
  it('detects a newly created project-local store', () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({ 'package.json': 'a', '.pnpm-store/v11/files/00/abc': 'x' });
    expect(wroteProjectLocalPnpmStore(before, after)).toBe(true);
  });

  it('is false when no .pnpm-store was written', () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({ 'package.json': 'a', 'pnpm-lock.yaml': 'l' });
    expect(wroteProjectLocalPnpmStore(before, after)).toBe(false);
  });

  it('is false when the store already existed before', () => {
    const before = snap({ '.pnpm-store/v11/files/00/abc': 'x' });
    const after = snap({ '.pnpm-store/v11/files/00/abc': 'x' });
    expect(wroteProjectLocalPnpmStore(before, after)).toBe(false);
  });
});
