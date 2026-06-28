import { describe, expect, it } from 'vitest';
import { classifyProjectMode, writeActionLine } from '../src/mode.js';

describe('classifyProjectMode', () => {
  it('reports no-deps when nothing is installed (other signals irrelevant)', () => {
    expect(classifyProjectMode({ hasDeps: false, hostNative: true, foreignNative: true })).toBe('no-deps');
  });

  it('host-native wins over foreign', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: true, foreignNative: true })).toBe('host-native');
  });

  it('container-built when only foreign (Linux-native) binaries are present', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: false, foreignNative: true })).toBe('container-built');
  });

  it('deps-without-native-signal when a tree exists but carries no platform-specific packages', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: false, foreignNative: false })).toBe('deps-without-native-signal');
  });
});

describe('writeActionLine', () => {
  it('leads with the action verb, names the pm and mode, and states the honest no-boundary line', () => {
    const line = writeActionLine({ verb: 'installing', pm: 'pnpm', mode: 'host-native' });
    expect(line).toBe('installing natively on the host with pnpm (host-native deps; gates ran, no container boundary)');
    expect(line).not.toContain('—');
  });

  it('uses the operation verb, so a remove announces a removal not an install', () => {
    expect(writeActionLine({ verb: 'removing', pm: 'pnpm', mode: 'host-native' })).toMatch(/^removing natively on the host with pnpm/);
  });

  it('reflects the package manager and mode in each segment', () => {
    expect(writeActionLine({ verb: 'adding', pm: 'yarn', mode: 'no-deps' })).toContain('yarn');
    expect(writeActionLine({ verb: 'adding', pm: 'bun', mode: 'no-deps' })).toContain('no deps yet');
  });
});
