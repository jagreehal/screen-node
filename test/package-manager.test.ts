import { describe, expect, it } from 'vitest';
import { parsePackageManagerField, pmArgv, pmAuditFixArgv, pmAuditSignaturesArgv, pmDefaultRegistryHost, pmExecArgv, pmScriptArgv, pmUpdateArgv } from '../src/package-manager.js';

describe('pmDefaultRegistryHost', () => {
  it('returns yarnpkg.com only for yarn (classic defaults there); npm/pnpm/bun use the npm registry', () => {
    expect(pmDefaultRegistryHost('yarn')).toBe('yarnpkg.com');
    expect(pmDefaultRegistryHost('npm')).toBeUndefined();
    expect(pmDefaultRegistryHost('pnpm')).toBeUndefined();
    expect(pmDefaultRegistryHost('bun')).toBeUndefined();
  });
});

describe('parsePackageManagerField', () => {
  it('parses name and version', () => {
    expect(parsePackageManagerField('pnpm@9.15.0')).toEqual({ name: 'pnpm', version: '9.15.0', raw: 'pnpm@9.15.0' });
  });
  it('strips the integrity hash from version but keeps it in raw', () => {
    expect(parsePackageManagerField('pnpm@11.5.3+sha512.abc')).toEqual({
      name: 'pnpm',
      version: '11.5.3',
      raw: 'pnpm@11.5.3+sha512.abc',
    });
  });
  it('returns null for absent, non-string, or unknown managers', () => {
    expect(parsePackageManagerField(undefined)).toBeNull();
    expect(parsePackageManagerField(123)).toBeNull();
    expect(parsePackageManagerField('pnpm')).toBeNull();
    expect(parsePackageManagerField('deno@1.0.0')).toBeNull();
  });
  it('rejects whitespace and shell metacharacters', () => {
    expect(parsePackageManagerField('pnpm@9.15.0 && curl attacker')).toBeNull();
    expect(parsePackageManagerField('pnpm@9.15.0\nRUN echo hi')).toBeNull();
    expect(parsePackageManagerField('pnpm@9.15.0;echo hi')).toBeNull();
  });
});

describe('pmArgv', () => {
  it('adds deps as exact versions by default, routing pnpm/yarn through corepack', () => {
    expect(pmArgv('npm', 'add', ['zod'])).toEqual(['npm', 'install', '--save-exact', 'zod']);
    expect(pmArgv('pnpm', 'add', ['zod'])).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'zod']);
    expect(pmArgv('yarn', 'add', ['zod'])).toEqual(['corepack', 'yarn', 'add', '--exact', 'zod']);
    expect(pmArgv('bun', 'add', ['zod'])).toEqual(['bun', 'add', '--exact', 'zod']);
  });

  it('removes deps with each PM’s drop verb, npm `uninstall`, others `remove`, no exact defaulting', () => {
    expect(pmArgv('npm', 'remove', ['lodash'])).toEqual(['npm', 'uninstall', 'lodash']);
    expect(pmArgv('pnpm', 'remove', ['zod'])).toEqual(['corepack', 'pnpm', 'remove', 'zod']);
    expect(pmArgv('yarn', 'remove', ['react', 'react-dom'])).toEqual(['corepack', 'yarn', 'remove', 'react', 'react-dom']);
    expect(pmArgv('bun', 'remove', ['left-pad'])).toEqual(['bun', 'remove', 'left-pad']);
  });
});

describe('pmExecArgv', () => {
  it('uses bunx for bun projects and npx everywhere else (works regardless of the project PM)', () => {
    expect(pmExecArgv('bun', ['vite'])).toEqual(['bunx', 'vite']);
    expect(pmExecArgv('npm', ['vite', '--port', '3000'])).toEqual(['npx', 'vite', '--port', '3000']);
    expect(pmExecArgv('pnpm', ['eslint', '.'])).toEqual(['npx', 'eslint', '.']);
    expect(pmExecArgv('yarn', ['tsc'])).toEqual(['npx', 'tsc']);
  });
});

describe('pmUpdateArgv', () => {
  it('preserves the verb the user typed, routing pnpm/yarn through corepack', () => {
    expect(pmUpdateArgv('npm', 'update', [])).toEqual(['npm', 'update']);
    expect(pmUpdateArgv('npm', 'up', ['lodash'])).toEqual(['npm', 'up', 'lodash']);
    expect(pmUpdateArgv('pnpm', 'up', ['--latest'])).toEqual(['corepack', 'pnpm', 'up', '--latest']);
    expect(pmUpdateArgv('yarn', 'upgrade', [])).toEqual(['corepack', 'yarn', 'upgrade']);
    expect(pmUpdateArgv('bun', 'update', [])).toEqual(['bun', 'update']);
  });
});

describe('pmScriptArgv', () => {
  it('uses each package manager’s native script invocation form', () => {
    expect(pmScriptArgv('npm', 'dev', [])).toEqual(['npm', 'run', 'dev']);
    expect(pmScriptArgv('pnpm', 'dev', [])).toEqual(['pnpm', 'dev']);
    expect(pmScriptArgv('yarn', 'dev', [])).toEqual(['yarn', 'dev']);
    expect(pmScriptArgv('bun', 'dev', [])).toEqual(['bun', 'dev']);
  });

  it('forwards npm script args through `--` while leaving other managers untouched', () => {
    expect(pmScriptArgv('npm', 'test', ['--watch'])).toEqual(['npm', 'run', 'test', '--', '--watch']);
    expect(pmScriptArgv('npm', 'test', ['--', '--watch'])).toEqual(['npm', 'run', 'test', '--', '--watch']);
    expect(pmScriptArgv('pnpm', 'test', ['--watch'])).toEqual(['pnpm', 'test', '--watch']);
  });
});

describe('pmAuditFixArgv', () => {
  it('builds the in-place remediation command for npm (positional fix) and pnpm (--fix flag)', () => {
    expect(pmAuditFixArgv('npm', 'fix', [])).toEqual(['npm', 'audit', 'fix']);
    expect(pmAuditFixArgv('npm', 'fix', ['--force'])).toEqual(['npm', 'audit', 'fix', '--force']);
    expect(pmAuditFixArgv('pnpm', '--fix', [])).toEqual(['corepack', 'pnpm', 'audit', '--fix']);
    expect(pmAuditFixArgv('pnpm', '--fix=update', ['--prod'])).toEqual(['corepack', 'pnpm', 'audit', '--fix=update', '--prod']);
  });

  it('throws for yarn and bun, which have no install-class audit-fix command', () => {
    expect(() => pmAuditFixArgv('yarn', 'fix', [])).toThrow(/does not support/i);
    expect(() => pmAuditFixArgv('bun', 'fix', [])).toThrow(/does not support/i);
  });
});

describe('pmAuditSignaturesArgv', () => {
  it('builds the registry signature-verification command for npm and pnpm', () => {
    expect(pmAuditSignaturesArgv('npm', [])).toEqual(['npm', 'audit', 'signatures']);
    expect(pmAuditSignaturesArgv('pnpm', ['--json'])).toEqual(['corepack', 'pnpm', 'audit', 'signatures', '--json']);
  });

  it('throws for yarn and bun, which have no audit signatures command', () => {
    expect(() => pmAuditSignaturesArgv('yarn', [])).toThrow(/does not support/i);
    expect(() => pmAuditSignaturesArgv('bun', [])).toThrow(/does not support/i);
  });
});
