import { describe, expect, it } from 'vitest';
import { effectivePm, isGlobalInstall, modeAwareWritePm, routePassthrough, unwrapSelfInvocation, writeVerb, type Route } from '../src/dispatch.js';

const route = (cmd: string): Route | undefined => routePassthrough(cmd.split(' ').filter(Boolean));

describe('routePassthrough, install', () => {
  it('routes a plain install for each package manager', () => {
    expect(route('npm install')).toEqual({ model: 'install', pm: 'npm', frozen: false, args: [] });
    expect(route('npm i')).toEqual({ model: 'install', pm: 'npm', frozen: false, args: [] });
    expect(route('pnpm install')).toEqual({ model: 'install', pm: 'pnpm', frozen: false, args: [] });
    expect(route('yarn install')).toEqual({ model: 'install', pm: 'yarn', frozen: false, args: [] });
  });

  it('treats a bare `yarn` as install but bare npm/pnpm as run (they print help)', () => {
    expect(route('yarn')).toEqual({ model: 'install', pm: 'yarn', frozen: false, args: [] });
    expect(route('npm')).toEqual({ model: 'run', argv: ['npm'] });
    expect(route('pnpm')).toEqual({ model: 'run', argv: ['pnpm'] });
  });

  it('detects reproducible installs', () => {
    expect(route('npm ci')).toEqual({ model: 'install', pm: 'npm', frozen: true, args: [] });
    expect(route('pnpm install --frozen-lockfile')).toEqual({ model: 'install', pm: 'pnpm', frozen: true, args: ['--frozen-lockfile'] });
    expect(route('yarn install --immutable')).toEqual({ model: 'install', pm: 'yarn', frozen: true, args: ['--immutable'] });
  });

  it('passes install flags through', () => {
    expect(route('npm install --legacy-peer-deps')).toEqual({ model: 'install', pm: 'npm', frozen: false, args: ['--legacy-peer-deps'] });
  });
});

describe('routePassthrough, add', () => {
  it('routes explicit adds', () => {
    expect(route('pnpm add zod')).toEqual({ model: 'add', pm: 'pnpm', pkgs: ['zod'] });
    expect(route('yarn add react react-dom')).toEqual({ model: 'add', pm: 'yarn', pkgs: ['react', 'react-dom'] });
  });

  it('treats `npm install <pkg>` (and flagged variants) as an add', () => {
    expect(route('npm install lodash')).toEqual({ model: 'add', pm: 'npm', pkgs: ['lodash'] });
    expect(route('npm i -D vitest')).toEqual({ model: 'add', pm: 'npm', pkgs: ['-D', 'vitest'] });
    expect(route('pnpm add -D typescript')).toEqual({ model: 'add', pm: 'pnpm', pkgs: ['-D', 'typescript'] });
  });
});

describe('routePassthrough, remove', () => {
  it('routes each package manager’s drop-a-dep verbs (and aliases) to the contained remove model', () => {
    expect(route('npm uninstall lodash')).toEqual({ model: 'remove', pm: 'npm', pkgs: ['lodash'] });
    expect(route('npm remove lodash')).toEqual({ model: 'remove', pm: 'npm', pkgs: ['lodash'] });
    expect(route('npm rm lodash')).toEqual({ model: 'remove', pm: 'npm', pkgs: ['lodash'] });
    expect(route('npm un lodash')).toEqual({ model: 'remove', pm: 'npm', pkgs: ['lodash'] });
    expect(route('pnpm remove zod')).toEqual({ model: 'remove', pm: 'pnpm', pkgs: ['zod'] });
    expect(route('pnpm rm zod')).toEqual({ model: 'remove', pm: 'pnpm', pkgs: ['zod'] });
    expect(route('yarn remove react react-dom')).toEqual({ model: 'remove', pm: 'yarn', pkgs: ['react', 'react-dom'] });
    expect(route('bun remove left-pad')).toEqual({ model: 'remove', pm: 'bun', pkgs: ['left-pad'] });
    expect(route('bun rm left-pad')).toEqual({ model: 'remove', pm: 'bun', pkgs: ['left-pad'] });
  });

  it('leaves `npm unlink` a plain run, un-symlinking a linked pkg is not a remove', () => {
    expect(route('npm unlink some-pkg')).toEqual({ model: 'run', argv: ['npm', 'unlink', 'some-pkg'] });
  });

  it('does NOT treat yarn `rm`/`un` as remove (yarn spells it only `remove`)', () => {
    expect(route('yarn rm zod')).toEqual({ model: 'run', argv: ['yarn', 'rm', 'zod'] });
  });
});

describe('routePassthrough, update', () => {
  it('routes the update family to the gated update model, per package manager', () => {
    expect(route('npm update')).toEqual({ model: 'update', pm: 'npm', verb: 'update', args: [] });
    expect(route('npm up')).toEqual({ model: 'update', pm: 'npm', verb: 'up', args: [] });
    expect(route('pnpm update')).toEqual({ model: 'update', pm: 'pnpm', verb: 'update', args: [] });
    expect(route('pnpm up')).toEqual({ model: 'update', pm: 'pnpm', verb: 'up', args: [] });
    expect(route('yarn upgrade')).toEqual({ model: 'update', pm: 'yarn', verb: 'upgrade', args: [] });
    expect(route('yarn up')).toEqual({ model: 'update', pm: 'yarn', verb: 'up', args: [] });
    expect(route('bun update')).toEqual({ model: 'update', pm: 'bun', verb: 'update', args: [] });
  });

  it('carries named packages and flags as args (preserving the verb)', () => {
    expect(route('npm update lodash react')).toEqual({ model: 'update', pm: 'npm', verb: 'update', args: ['lodash', 'react'] });
    expect(route('pnpm up --latest')).toEqual({ model: 'update', pm: 'pnpm', verb: 'up', args: ['--latest'] });
  });

  it('does NOT treat `bun upgrade` as a package update, it upgrades the bun binary, so it stays a run', () => {
    expect(route('bun upgrade')).toEqual({ model: 'run', argv: ['bun', 'upgrade'] });
  });

  it('routes `dedupe` (and npm `ddp`) install-class so it can re-resolve against the registry', () => {
    expect(route('npm dedupe')).toEqual({ model: 'update', pm: 'npm', verb: 'dedupe', args: [] });
    expect(route('npm ddp')).toEqual({ model: 'update', pm: 'npm', verb: 'ddp', args: [] });
    expect(route('pnpm dedupe')).toEqual({ model: 'update', pm: 'pnpm', verb: 'dedupe', args: [] });
    expect(route('yarn dedupe')).toEqual({ model: 'update', pm: 'yarn', verb: 'dedupe', args: [] });
  });

  it('leaves `bun dedupe` a plain run, bun has no dedupe verb', () => {
    expect(route('bun dedupe')).toEqual({ model: 'run', argv: ['bun', 'dedupe'] });
  });
});

describe('routePassthrough, audit fix', () => {
  it('routes npm audit fix and pnpm audit --fix to the install-class audit-fix model', () => {
    expect(route('npm audit fix')).toEqual({ model: 'auditFix', pm: 'npm', fixToken: 'fix', args: [] });
    expect(route('npm audit fix --force')).toEqual({ model: 'auditFix', pm: 'npm', fixToken: 'fix', args: ['--force'] });
    expect(route('pnpm audit --fix')).toEqual({ model: 'auditFix', pm: 'pnpm', fixToken: '--fix', args: [] });
    expect(route('pnpm audit --prod --fix')).toEqual({ model: 'auditFix', pm: 'pnpm', fixToken: '--fix', args: ['--prod'] });
    expect(route('pnpm audit --fix=update --interactive')).toEqual({ model: 'auditFix', pm: 'pnpm', fixToken: '--fix=update', args: ['--interactive'] });
  });

  it('routes report-only audit to the read-only audit model (it needs the registry, installs nothing)', () => {
    expect(route('npm audit')).toEqual({ model: 'audit', argv: ['npm', 'audit'] });
    expect(route('pnpm audit')).toEqual({ model: 'audit', argv: ['pnpm', 'audit'] });
    expect(route('yarn audit')).toEqual({ model: 'audit', argv: ['yarn', 'audit'] });
    expect(route('bun audit --prod')).toEqual({ model: 'audit', argv: ['bun', 'audit', '--prod'] });
  });

  it('leaves yarn berry’s `yarn npm audit` as a plain run (the verb is `npm`, not `audit`)', () => {
    expect(route('yarn npm audit --all')).toEqual({ model: 'run', argv: ['yarn', 'npm', 'audit', '--all'] });
  });

  it('routes `audit signatures` (npm/pnpm) to its own read-only verification model', () => {
    expect(route('npm audit signatures')).toEqual({ model: 'auditSignatures', pm: 'npm', args: [] });
    expect(route('pnpm audit signatures')).toEqual({ model: 'auditSignatures', pm: 'pnpm', args: [] });
  });
});

describe('routePassthrough, run', () => {
  it('routes scripts and tools verbatim', () => {
    expect(route('npm run dev')).toEqual({ model: 'run', argv: ['npm', 'run', 'dev'] });
    expect(route('pnpm dev')).toEqual({ model: 'run', argv: ['pnpm', 'dev'] });
    expect(route('npm test')).toEqual({ model: 'run', argv: ['npm', 'test'] });
    expect(route('yarn start')).toEqual({ model: 'run', argv: ['yarn', 'start'] });
    expect(route('npx vite')).toEqual({ model: 'run', argv: ['npx', 'vite'] });
    expect(route('node server.js')).toEqual({ model: 'run', argv: ['node', 'server.js'] });
  });

  it('routes pm exec/dlx as run', () => {
    expect(route('pnpm dlx cowsay hi')).toEqual({ model: 'run', argv: ['pnpm', 'dlx', 'cowsay', 'hi'] });
    expect(route('npm exec -- tsc')).toEqual({ model: 'run', argv: ['npm', 'exec', '--', 'tsc'] });
  });

  it('routes the monorepo task runners (turbo/nx) verbatim', () => {
    expect(route('turbo run build')).toEqual({ model: 'run', argv: ['turbo', 'run', 'build'] });
    expect(route('turbo dev --filter=web')).toEqual({ model: 'run', argv: ['turbo', 'dev', '--filter=web'] });
    expect(route('nx build web')).toEqual({ model: 'run', argv: ['nx', 'build', 'web'] });
    expect(route('nx run-many -t test')).toEqual({ model: 'run', argv: ['nx', 'run-many', '-t', 'test'] });
  });
});

describe('routePassthrough, bun', () => {
  it('routes bun install/add through the install + add models', () => {
    expect(route('bun install')).toEqual({ model: 'install', pm: 'bun', frozen: false, args: [] });
    expect(route('bun i')).toEqual({ model: 'install', pm: 'bun', frozen: false, args: [] });
    expect(route('bun add zod')).toEqual({ model: 'add', pm: 'bun', pkgs: ['zod'] });
    expect(route('bun install lodash')).toEqual({ model: 'add', pm: 'bun', pkgs: ['lodash'] });
    expect(route('bun install --frozen-lockfile')).toEqual({ model: 'install', pm: 'bun', frozen: true, args: ['--frozen-lockfile'] });
  });

  it('routes bun scripts and runners verbatim (bunx is the exec runner, not the pm)', () => {
    expect(route('bun run dev')).toEqual({ model: 'run', argv: ['bun', 'run', 'dev'] });
    expect(route('bun test')).toEqual({ model: 'run', argv: ['bun', 'test'] });
    expect(route('bun x cowsay hi')).toEqual({ model: 'run', argv: ['bun', 'x', 'cowsay', 'hi'] });
    expect(route('bunx create-vite my-app')).toEqual({ model: 'run', argv: ['bunx', 'create-vite', 'my-app'] });
  });
});

describe('routePassthrough, not a pass-through', () => {
  it('returns undefined for unrecognized leaders and empty input', () => {
    expect(route('claude')).toBeUndefined();
    expect(route('frobnicate the widgets')).toBeUndefined();
    expect(route('')).toBeUndefined();
  });
});

describe('isGlobalInstall, global installs across every package manager', () => {
  // (cmd, args) mirrors how `main()` calls it: cmd is the leading token, args is everything after.
  const isGlobal = (cmd: string, rest: string) => {
    const args = rest.split(' ').filter(Boolean);
    return isGlobalInstall(cmd, routePassthrough([cmd, ...args])!, args);
  };

  it('flags -g / --global / --location=global for npm, pnpm, bun', () => {
    expect(isGlobal('npm', 'install -g typescript')).toBe(true);
    expect(isGlobal('npm', 'i --global typescript')).toBe(true);
    expect(isGlobal('npm', 'install --location=global typescript')).toBe(true);
    expect(isGlobal('pnpm', 'add -g typescript')).toBe(true);
    expect(isGlobal('pnpm', 'add --global typescript')).toBe(true);
    expect(isGlobal('bun', 'add -g typescript')).toBe(true);
  });

  it('flags yarn classic global subcommand (routes to run, not an install flag)', () => {
    expect(isGlobal('yarn', 'global add typescript')).toBe(true);
  });

  it('flags a global REMOVE too, uninstalling a host global cannot happen in a container', () => {
    expect(isGlobal('npm', 'uninstall -g typescript')).toBe(true);
    expect(isGlobal('pnpm', 'remove --global typescript')).toBe(true);
  });

  it('leaves normal (local) installs alone', () => {
    expect(isGlobal('npm', 'install lodash')).toBe(false);
    expect(isGlobal('pnpm', 'add zod')).toBe(false);
    expect(isGlobal('bun', 'install')).toBe(false);
    expect(isGlobal('yarn', 'add react')).toBe(false);
  });
});

const unwrap = (cmd: string): string[] | undefined => unwrapSelfInvocation(cmd.split(' ').filter(Boolean));

describe('unwrapSelfInvocation, never sandbox sandbox', () => {
  it('unwraps `npx @jagreehal/screen-node <cmd>` to the bare subcommand', () => {
    expect(unwrap('npx @jagreehal/screen-node check lodash')).toEqual(['check', 'lodash']);
  });

  it('handles every npx-family runner and a version pin', () => {
    expect(unwrap('bunx @jagreehal/screen-node doctor')).toEqual(['doctor']);
    expect(unwrap('pnpm dlx @jagreehal/screen-node@latest check')).toEqual(['check']);
    expect(unwrap('npm exec @jagreehal/screen-node -- check express')).toEqual(['check', 'express']);
    expect(unwrap('x screen-node@1.7.0 verify')).toEqual(['verify']);
  });

  it('skips runner flags like -y before the package', () => {
    expect(unwrap('npx -y @jagreehal/screen-node check')).toEqual(['check']);
  });

  it('returns [] when the CLI is invoked with no subcommand (so it falls through to help)', () => {
    expect(unwrap('npx @jagreehal/screen-node')).toEqual([]);
  });

  it('leaves a real npx of some OTHER package alone', () => {
    expect(unwrap('npx cowsay hi')).toBeUndefined();
    expect(unwrap('npm install lodash')).toBeUndefined();
    expect(unwrap('check lodash')).toBeUndefined();
  });
});

describe('effectivePm', () => {
  it('follows the routed package manager for pm-bearing routes, not the repo pm', () => {
    // `sandbox npm install` in a pnpm repo gates and pins under npm (route.pm), not facts.pm.
    expect(effectivePm(route('npm install')!, 'pnpm')).toBe('npm');
    expect(effectivePm(route('yarn add zod')!, 'pnpm')).toBe('yarn');
    expect(effectivePm(route('npm uninstall lodash')!, 'pnpm')).toBe('npm');
    expect(effectivePm(route('npm update')!, 'pnpm')).toBe('npm');
  });

  it('falls back to the repo pm for argv-only routes (audit/run carry no pm)', () => {
    expect(effectivePm(route('npm audit')!, 'pnpm')).toBe('pnpm');
    expect(effectivePm(route('npm run build')!, 'pnpm')).toBe('pnpm');
  });
});

describe('modeAwareWritePm', () => {
  it('reports the pm for every tree-mutating install (install/add/update/remove)', () => {
    expect(modeAwareWritePm(route('npm install')!)).toBe('npm');
    expect(modeAwareWritePm(route('pnpm add zod')!)).toBe('pnpm');
    expect(modeAwareWritePm(route('yarn upgrade')!)).toBe('yarn');
    // remove rewrites node_modules too, so it stays in the project's one mode (unlike containerWritePm).
    expect(modeAwareWritePm(route('npm uninstall lodash')!)).toBe('npm');
    expect(modeAwareWritePm(route('pnpm remove zod')!)).toBe('pnpm');
  });

  it('returns undefined for read-only routes that touch no deps (audit, run)', () => {
    expect(modeAwareWritePm(route('npm audit')!)).toBeUndefined();
    expect(modeAwareWritePm(route('npm run build')!)).toBeUndefined();
  });
});

describe('writeVerb', () => {
  it('names the actual operation so the action line is honest (remove != install)', () => {
    expect(writeVerb(route('npm install')!)).toBe('installing');
    expect(writeVerb(route('pnpm add zod')!)).toBe('adding');
    expect(writeVerb(route('npm update')!)).toBe('updating');
    expect(writeVerb(route('npm uninstall lodash')!)).toBe('removing');
  });
});
