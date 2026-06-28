import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBareCommand, HOOK_SCRIPT, installAgentHook, mergeAgentSettings, mergePreToolUseHook, SECRET_DENY_RULES } from '../src/hook.js';

/** Commands the host agent must be pushed to run through `sandbox`. */
const BLOCKED = [
  'npm install',
  'npm i',
  'npm ci',
  'npm install zod',
  'npm run dev',
  'npm test',
  'npm exec cowsay',
  'pnpm install',
  'pnpm add zod',
  'pnpm dlx create-vite',
  'yarn',
  'yarn add left-pad',
  'bun install',
  'bun add hono',
  'npx vite',
  'bunx tsx script.ts',
  'npm uninstall lodash',
  'npm rm lodash',
  'pnpm remove zod',
  'yarn remove react',
  'bun rm left-pad',
  'npm dedupe',
  'pnpm dedupe',
  'cd packages/app && npm install',
  'FOO=bar sudo npm ci',
  'echo hi && pnpm add zod',
];

/** Commands that must pass through untouched. */
const ALLOWED = [
  'sandbox npm install',
  'sandbox pnpm add zod',
  'sandbox npm run dev',
  'sandbox-node npx vite',
  'npm ls',
  'npm view zod',
  'npm outdated',
  'npm config get registry',
  'npm whoami',
  'pnpm why zod',
  'git status',
  'ls -la',
  'echo "remember to npm install"', // npm appears only inside an echoed string
  'node script.js',
  'cd app',
];

describe('classifyBareCommand', () => {
  it.each(BLOCKED)('blocks: %s', (cmd) => {
    expect(classifyBareCommand(cmd).block).toBe(true);
  });

  it.each(ALLOWED)('allows: %s', (cmd) => {
    expect(classifyBareCommand(cmd).block).toBe(false);
  });

  it('block reason tells the agent how to re-run it', () => {
    const decision = classifyBareCommand('npm install');
    expect(decision.reason).toContain('sandbox install');
  });

  it('suggests the simplified rerun forms for common commands', () => {
    expect(classifyBareCommand('npm install zod').reason).toContain('sandbox add zod');
    expect(classifyBareCommand('pnpm add zod').reason).toContain('sandbox add zod');
    expect(classifyBareCommand('npm update').reason).toContain('sandbox update');
    expect(classifyBareCommand('npm run dev').reason).toContain('sandbox dev');
    expect(classifyBareCommand('npx vite').reason).toContain('sandbox x vite');
  });

  it('preserves the explicit passthrough form when simplification would drop semantics', () => {
    expect(classifyBareCommand('npm ci').reason).toContain('sandbox npm ci');
    expect(classifyBareCommand('pnpm install --frozen-lockfile').reason).toContain('sandbox pnpm install --frozen-lockfile');
    expect(classifyBareCommand('npm install -D vitest').reason).toContain('sandbox npm install -D vitest');
    expect(classifyBareCommand('npx -y cowsay hi').reason).toContain('sandbox npx -y cowsay hi');
    expect(classifyBareCommand('npm exec -- tsc').reason).toContain('sandbox npm exec -- tsc');
    expect(classifyBareCommand('FOO=bar sudo npm ci').reason).toContain('sandbox npm ci');
  });
});

// The shipped .mjs reimplements the classifier with no imports (so it runs anywhere).
// Execute it against the same table so the two can never silently drift apart.
describe('HOOK_SCRIPT (the shipped hook, executed)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-hook-'));
  const scriptPath = path.join(dir, 'enforce-sandbox.mjs');
  writeFileSync(scriptPath, HOOK_SCRIPT);

  const run = (command: string) => spawnSync(process.execPath, [scriptPath], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });

  it.each(BLOCKED)('exits 2 (deny) for: %s', (cmd) => {
    const { status, stderr } = run(cmd);
    expect(status).toBe(2);
    expect(stderr).toContain('Blocked by sandbox');
  });

  it('prints a runnable rerun command for wrapped commands', () => {
    const { stderr } = run('FOO=bar sudo npm ci');
    expect(stderr).toContain('Re-run it as:  sandbox npm ci');
    expect(stderr).not.toContain('sandbox FOO=bar sudo npm ci');
  });

  it.each(ALLOWED)('exits 0 (allow) for: %s', (cmd) => {
    expect(run(cmd).status).toBe(0);
  });
});

describe('mergePreToolUseHook', () => {
  it('adds a Bash PreToolUse entry that calls the script', () => {
    const merged = mergePreToolUseHook({});
    const pre = (merged.hooks as any).PreToolUse;
    expect(pre[0].matcher).toBe('Bash');
    expect(pre[0].hooks[0].command).toContain('enforce-sandbox.mjs');
  });

  it('preserves unrelated settings and existing hooks', () => {
    const merged = mergePreToolUseHook({ model: 'opus', hooks: { PostToolUse: [{ hooks: [] }] } });
    expect(merged.model).toBe('opus');
    expect((merged.hooks as any).PostToolUse).toHaveLength(1);
    expect((merged.hooks as any).PreToolUse).toHaveLength(1);
  });

  it('is idempotent, re-merging does not duplicate the entry', () => {
    const once = mergePreToolUseHook({});
    const twice = mergePreToolUseHook(once);
    expect((twice.hooks as any).PreToolUse).toHaveLength(1);
  });
});

describe('mergeAgentSettings', () => {
  it('adds the hook and the secret-deny rules', () => {
    const merged = mergeAgentSettings({});
    expect((merged.hooks as any).PreToolUse[0].matcher).toBe('Bash');
    expect((merged.permissions as any).deny).toEqual(SECRET_DENY_RULES);
  });

  it('unions deny rules with the user\'s existing ones, no duplicates', () => {
    const merged = mergeAgentSettings({ permissions: { deny: ['Read(./private/**)', 'Read(./.env)'] } });
    const deny = (merged.permissions as any).deny as string[];
    expect(deny).toContain('Read(./private/**)'); // user's rule kept
    expect(deny).toContain('Read(./secrets/**)'); // ours added
    expect(deny.filter((r) => r === 'Read(./.env)')).toHaveLength(1); // overlap not duplicated
  });

  it('preserves unrelated permission keys (allow/ask)', () => {
    const merged = mergeAgentSettings({ permissions: { allow: ['Bash(npm:*)'], ask: ['Bash(git push:*)'] } });
    expect((merged.permissions as any).allow).toEqual(['Bash(npm:*)']);
    expect((merged.permissions as any).ask).toEqual(['Bash(git push:*)']);
  });

  it('is idempotent', () => {
    const twice = mergeAgentSettings(mergeAgentSettings({}));
    expect((twice.permissions as any).deny).toEqual(SECRET_DENY_RULES);
    expect((twice.hooks as any).PreToolUse).toHaveLength(1);
  });
});

describe('installAgentHook', () => {
  const seedSettings = (content: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-install-'));
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'settings.json'), content);
    return dir;
  };

  it('creates settings.json with the hook and secret-deny rules when none exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-install-'));
    const { script, settings, wired } = installAgentHook(dir);
    expect(wired).toBe(true);
    expect(readFileSync(script, 'utf8')).toContain('Blocked by sandbox');
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('enforce-sandbox.mjs');
    expect(parsed.permissions.deny).toContain('Read(./.env)');
  });

  it('merges into a valid existing settings.json, preserving other keys', () => {
    const dir = seedSettings(JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }));
    const { wired, settings } = installAgentHook(dir);
    expect(wired).toBe(true);
    const parsed = JSON.parse(readFileSync(settings, 'utf8'));
    expect(parsed.model).toBe('opus');
    expect(parsed.permissions.allow).toEqual(['Bash']);
    expect(parsed.permissions.deny).toContain('Read(./secrets/**)');
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('enforce-sandbox.mjs');
  });

  // The data-loss guard: a malformed settings.json must NEVER be overwritten.
  it('leaves a malformed settings.json byte-for-byte intact and reports wired:false', () => {
    const malformed = '{ "model": "opus", }'; // trailing comma — invalid JSON
    const dir = seedSettings(malformed);
    const { wired, settings } = installAgentHook(dir);
    expect(wired).toBe(false);
    expect(readFileSync(settings, 'utf8')).toBe(malformed); // untouched
  });

  it('does not overwrite a settings file that parses to a non-object', () => {
    const notAnObject = '["unexpected", "array"]';
    const dir = seedSettings(notAnObject);
    const { wired, settings } = installAgentHook(dir);
    expect(wired).toBe(false);
    expect(readFileSync(settings, 'utf8')).toBe(notAnObject);
  });

  it('still writes the hook script even when settings can\'t be wired', () => {
    const dir = seedSettings('{ bad json');
    const { script, wired } = installAgentHook(dir);
    expect(wired).toBe(false);
    expect(readFileSync(script, 'utf8')).toContain('Blocked by sandbox');
  });
});
