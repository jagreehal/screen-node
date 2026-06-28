import { describe, expect, it } from 'vitest';
import { chooseInstallTarget, classifyProjectMode, crossModeWarning, writeActionLine } from '../src/mode.js';

describe('crossModeWarning', () => {
  it('warns when a host-native tree is about to be clobbered by a contained install', () => {
    const w = crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 3, pm: 'pnpm' });
    expect(w).toBeDefined();
    expect(w).toContain('currently uses host-native node_modules');
    expect(w).toContain('Keep host-native deps: `pnpm install`');
    expect(w).toContain('remove node_modules'); // and the deliberate switch
  });

  it('stays quiet when the tree has no host-native packages (container tree or pure-JS)', () => {
    expect(crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 0, pm: 'pnpm' })).toBeUndefined();
  });

  it('stays quiet on Linux, where container and host share a platform (no mismatch to warn about)', () => {
    // Even with host-native packages present, a Linux container tree loads on a Linux host.
    expect(crossModeWarning({ hostOs: 'linux', hostNativeCount: () => 5, pm: 'pnpm' })).toBeUndefined();
  });

  it('skips the (potentially expensive) scan entirely on Linux: the count thunk is never called', () => {
    let scanned = false;
    crossModeWarning({
      hostOs: 'linux',
      hostNativeCount: () => {
        scanned = true;
        return 5;
      },
      pm: 'pnpm',
    });
    expect(scanned).toBe(false);
  });

  it('is stale-proof by construction: it reads the live count, never a persisted marker', () => {
    // A host install after a contained one brings host-native packages back, so the count rises and
    // the warning fires again. A sentinel file would have stayed and wrongly suppressed it.
    expect(crossModeWarning({ hostOs: 'win32', hostNativeCount: () => 2, pm: 'npm' })).toBeDefined();
  });

  it('names the project package manager in the warning', () => {
    expect(crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 1, pm: 'yarn' })).toContain('yarn');
    expect(crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 1, pm: 'bun' })).toContain('bun');
  });
});

describe('classifyProjectMode', () => {
  it('reports no-deps when nothing is installed (other signals irrelevant)', () => {
    expect(classifyProjectMode({ hasDeps: false, hostNative: true, foreignNative: true })).toBe('no-deps');
  });

  it('host-native wins over foreign (a host-native tree is the one a contained install would clobber)', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: true, foreignNative: true })).toBe('host-native');
  });

  it('container-built when only foreign (Linux-native) binaries are present', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: false, foreignNative: true })).toBe('container-built');
  });

  it('deps-without-native-signal when a tree exists but carries no platform-specific packages', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: false, foreignNative: false })).toBe('deps-without-native-signal');
  });
});

describe('chooseInstallTarget', () => {
  it('keeps a container-built tree contained (one mode per project)', () => {
    expect(chooseInstallTarget('container-built', false)).toBe('container');
  });

  it('installs natively for host-native, fresh, and no-signal trees (best DX: host IDE loads the result)', () => {
    expect(chooseInstallTarget('host-native', false)).toBe('native');
    expect(chooseInstallTarget('no-deps', false)).toBe('native');
    expect(chooseInstallTarget('deps-without-native-signal', false)).toBe('native');
  });

  it('forceContainer (explicit `sandbox <pm>`) always wins, regardless of mode', () => {
    expect(chooseInstallTarget('host-native', true)).toBe('container');
    expect(chooseInstallTarget('no-deps', true)).toBe('container');
    expect(chooseInstallTarget('deps-without-native-signal', true)).toBe('container');
    expect(chooseInstallTarget('container-built', true)).toBe('container');
  });
});

describe('writeActionLine', () => {
  it('native: leads with the action verb, names the pm and mode, and states the honest no-boundary line', () => {
    const line = writeActionLine({ verb: 'installing', pm: 'pnpm', mode: 'host-native', target: 'native' });
    expect(line).toBe('installing natively on the host with pnpm (host-native deps; gates ran, no container boundary)');
    expect(line).not.toContain('—');
  });

  it('container: leads with the action verb, names the pm and mode, and states what the boundary buys', () => {
    const line = writeActionLine({ verb: 'installing', pm: 'npm', mode: 'container-built', target: 'container' });
    expect(line).toBe('installing in a throwaway container with npm (container-built deps; no host creds, default-deny egress)');
    expect(line).not.toContain('—');
  });

  it('uses the operation verb, so a remove announces a removal not an install', () => {
    expect(writeActionLine({ verb: 'removing', pm: 'pnpm', mode: 'host-native', target: 'native' })).toMatch(/^removing natively on the host with pnpm/);
  });

  it('reflects the package manager and mode in each segment', () => {
    expect(writeActionLine({ verb: 'adding', pm: 'yarn', mode: 'no-deps', target: 'native' })).toContain('yarn');
    expect(writeActionLine({ verb: 'adding', pm: 'bun', mode: 'no-deps', target: 'native' })).toContain('no deps yet');
  });
});
