import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findHostIncompatiblePackages,
  findHostIncompatiblePackagesInWorkspace,
  findHostNativePackages,
  findHostNativePackagesInWorkspace,
  hostSatisfies,
  type HostPlatform,
} from '../src/native-deps.js';

const darwinArm: HostPlatform = { os: 'darwin', cpu: 'arm64' };
const linuxArm: HostPlatform = { os: 'linux', cpu: 'arm64' };

describe('hostSatisfies', () => {
  it('treats absent os/cpu as compatible with any host', () => {
    expect(hostSatisfies({}, darwinArm)).toBe(true);
    expect(hostSatisfies({ os: [], cpu: [] }, darwinArm)).toBe(true);
  });

  it('matches positive os/cpu lists', () => {
    expect(hostSatisfies({ os: ['linux'], cpu: ['arm64'] }, linuxArm)).toBe(true);
    expect(hostSatisfies({ os: ['linux'], cpu: ['arm64'] }, darwinArm)).toBe(false);
    expect(hostSatisfies({ os: 'darwin' }, darwinArm)).toBe(true);
  });

  it('honours negated entries', () => {
    expect(hostSatisfies({ os: ['!win32'] }, darwinArm)).toBe(true);
    expect(hostSatisfies({ os: ['!darwin'] }, darwinArm)).toBe(false);
  });

  it('requires both os and cpu to match', () => {
    expect(hostSatisfies({ os: ['darwin'], cpu: ['x64'] }, darwinArm)).toBe(false);
  });
});

describe('findHostIncompatiblePackages', () => {
  let root: string;
  let nodeModules: string;

  const addPkg = (name: string, manifest: Record<string, unknown>) => {
    const dir = path.join(nodeModules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sbx-native-'));
    nodeModules = path.join(root, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags Linux-native deps as incompatible on a macOS host', () => {
    addPkg('@rollup/rollup-linux-arm64-gnu', { os: ['linux'], cpu: ['arm64'] });
    addPkg('@esbuild/linux-x64', { os: ['linux'], cpu: ['x64'] });
    addPkg('@img/sharp-darwin-arm64', { os: ['darwin'], cpu: ['arm64'] }); // compatible
    addPkg('lodash', {}); // no platform constraint
    addPkg('left-pad', { os: ['linux'] }); // platform-bound but no token in name → ignored (cheap scan)

    const result = findHostIncompatiblePackages(nodeModules, darwinArm);
    expect(result).toEqual(['@esbuild/linux-x64', '@rollup/rollup-linux-arm64-gnu']);
  });

  it('finds npm-style nested native deps', () => {
    addPkg('vite', {});
    addPkg(path.join('vite', 'node_modules', '@rollup', 'rollup-linux-arm64-gnu'), { os: ['linux'], cpu: ['arm64'] });

    expect(findHostIncompatiblePackages(nodeModules, darwinArm)).toEqual(['@rollup/rollup-linux-arm64-gnu']);
  });

  it('finds pnpm virtual-store native deps', () => {
    addPkg(path.join('.pnpm', '@rollup+rollup-linux-arm64-gnu@4.0.0', 'node_modules', '@rollup', 'rollup-linux-arm64-gnu'), {
      os: ['linux'],
      cpu: ['arm64'],
    });
    addPkg(path.join('.pnpm', '@img+sharp-darwin-arm64@0.0.0', 'node_modules', '@img', 'sharp-darwin-arm64'), {
      os: ['darwin'],
      cpu: ['arm64'],
    });

    expect(findHostIncompatiblePackages(nodeModules, darwinArm)).toEqual(['@rollup/rollup-linux-arm64-gnu']);
  });

  it('returns nothing when the host matches the install platform', () => {
    addPkg('@rollup/rollup-linux-arm64-gnu', { os: ['linux'], cpu: ['arm64'] });
    expect(findHostIncompatiblePackages(nodeModules, linuxArm)).toEqual([]);
  });

  it('ignores token-named packages that carry no os/cpu constraint', () => {
    addPkg('linux-release-info', {}); // name has a token but is plain JS
    expect(findHostIncompatiblePackages(nodeModules, darwinArm)).toEqual([]);
  });

  it('returns empty when node_modules is absent', () => {
    expect(findHostIncompatiblePackages(path.join(root, 'missing'), darwinArm)).toEqual([]);
  });
});

describe('findHostNativePackages', () => {
  let root: string;
  let nodeModules: string;

  const addPkg = (name: string, manifest: Record<string, unknown>) => {
    const dir = path.join(nodeModules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sbx-native-host-'));
    nodeModules = path.join(root, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is the mirror of incompatible: collects platform-specific packages that DO satisfy the host', () => {
    addPkg('@rollup/rollup-linux-arm64-gnu', { os: ['linux'], cpu: ['arm64'] }); // foreign on macOS
    addPkg('@img/sharp-darwin-arm64', { os: ['darwin'], cpu: ['arm64'] }); // host-native on macOS
    addPkg('lodash', {}); // pure JS, neither

    expect(findHostNativePackages(nodeModules, darwinArm)).toEqual(['@img/sharp-darwin-arm64']);
  });

  it('returns nothing for a pure-JS tree (no native binaries to lose either way)', () => {
    addPkg('lodash', {});
    addPkg('linux-release-info', {}); // token in name but no os/cpu constraint
    expect(findHostNativePackages(nodeModules, darwinArm)).toEqual([]);
  });

  it('a Linux tree reads as host-native on a Linux host (the no-mismatch case)', () => {
    addPkg('@rollup/rollup-linux-arm64-gnu', { os: ['linux'], cpu: ['arm64'] });
    expect(findHostNativePackages(nodeModules, linuxArm)).toEqual(['@rollup/rollup-linux-arm64-gnu']);
    // and the same tree is foreign-incompatible on macOS, so the two functions partition the tree
    expect(findHostNativePackages(nodeModules, darwinArm)).toEqual([]);
  });
});

describe('findHostNativePackagesInWorkspace', () => {
  let root: string;

  const addPkg = (base: string, name: string, manifest: Record<string, unknown>) => {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sbx-native-host-ws-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scans workspace-local node_modules as well as the root', () => {
    addPkg(path.join(root, 'node_modules'), '@img/sharp-darwin-arm64', { os: ['darwin'], cpu: ['arm64'] });
    addPkg(path.join(root, 'packages', 'web', 'node_modules'), '@rollup/rollup-darwin-arm64', { os: ['darwin'], cpu: ['arm64'] });
    addPkg(path.join(root, 'node_modules'), '@esbuild/linux-x64', { os: ['linux'], cpu: ['x64'] }); // foreign, excluded

    expect(findHostNativePackagesInWorkspace(root, darwinArm)).toEqual([
      '@img/sharp-darwin-arm64',
      '@rollup/rollup-darwin-arm64',
    ]);
  });
});

describe('findHostIncompatiblePackagesInWorkspace', () => {
  let root: string;

  const addPkg = (base: string, name: string, manifest: Record<string, unknown>) => {
    const dir = path.join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sbx-native-workspace-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scans workspace-local node_modules as well as the root', () => {
    addPkg(path.join(root, 'node_modules'), '@esbuild/linux-x64', { os: ['linux'], cpu: ['x64'] });
    addPkg(path.join(root, 'packages', 'web', 'node_modules'), '@rollup/rollup-linux-arm64-gnu', { os: ['linux'], cpu: ['arm64'] });

    expect(findHostIncompatiblePackagesInWorkspace(root, darwinArm)).toEqual([
      '@esbuild/linux-x64',
      '@rollup/rollup-linux-arm64-gnu',
    ]);
  });
});
