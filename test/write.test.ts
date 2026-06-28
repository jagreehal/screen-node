import { describe, expect, it } from 'vitest';
import type { SandboxConfig } from '../src/config.js';
import type { Route } from '../src/dispatch.js';
import { resolvedFrozen, routeToHostArgv, type PlanOptions } from '../src/write.js';

// The write subsystem is now its own importable module (it used to be nested closures in the
// self-executing cli.ts). These lock the host-argv builder and the frozen resolution that the native
// and SANDBOX_OFF paths share. End-to-end native-vs-container routing is covered by the --json
// integration tests (test/integration/cli.test.ts).

describe('routeToHostArgv', () => {
  it('builds the plain install argv per package manager when not frozen', () => {
    expect(routeToHostArgv({ model: 'install', pm: 'npm', frozen: false, args: [] })).toEqual(['npm', 'install']);
    expect(routeToHostArgv({ model: 'install', pm: 'pnpm', frozen: false, args: [] })).toEqual(['corepack', 'pnpm', 'install']);
  });

  it('uses the reproducible-install argv when frozen, so native honours --frozen like the contained path', () => {
    expect(routeToHostArgv({ model: 'install', pm: 'npm', frozen: false, args: [] }, { frozen: true })).toEqual(['npm', 'ci']);
    expect(routeToHostArgv({ model: 'install', pm: 'pnpm', frozen: false, args: [] }, { frozen: true })).toEqual(['corepack', 'pnpm', 'install', '--frozen-lockfile']);
  });

  it('frozen yarn picks immutable on Berry and frozen-lockfile on classic', () => {
    expect(routeToHostArgv({ model: 'install', pm: 'yarn', frozen: false, args: [] }, { frozen: true, yarnBerry: true })).toEqual(['corepack', 'yarn', 'install', '--immutable']);
    expect(routeToHostArgv({ model: 'install', pm: 'yarn', frozen: false, args: [] }, { frozen: true, yarnBerry: false })).toEqual(['corepack', 'yarn', 'install', '--frozen-lockfile']);
  });

  it('passes the route through for non-install models, keeping the gate engine pins intact', () => {
    // The pin (`--save-exact`/a pinned version) rides in route.pkgs/args, so it survives to the host.
    expect(routeToHostArgv({ model: 'add', pm: 'pnpm', pkgs: ['--save-exact', 'zod@3.23.8'] })).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'zod@3.23.8']);
    expect(routeToHostArgv({ model: 'remove', pm: 'npm', pkgs: ['left-pad'] })).toEqual(['npm', 'uninstall', 'left-pad']);
    expect(routeToHostArgv({ model: 'run', argv: ['npx', 'vite'] })).toEqual(['npx', 'vite']);
  });
});

describe('resolvedFrozen', () => {
  const cfg = (frozen: boolean) => ({ install: { frozen } }) as SandboxConfig;
  const installRoute = (frozen: boolean): Route => ({ model: 'install', pm: 'npm', frozen, args: [] });

  it('is true when the route itself is frozen, regardless of opts/config', () => {
    expect(resolvedFrozen(installRoute(true), {} as PlanOptions, cfg(false))).toBe(true);
  });

  it('falls back to the per-run override, then to config', () => {
    expect(resolvedFrozen(installRoute(false), { frozen: true } as PlanOptions, cfg(false))).toBe(true);
    expect(resolvedFrozen(installRoute(false), {} as PlanOptions, cfg(true))).toBe(true);
  });

  it('is false when nothing asks for frozen', () => {
    expect(resolvedFrozen(installRoute(false), {} as PlanOptions, cfg(false))).toBe(false);
  });
});
