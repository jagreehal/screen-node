import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyHostGroups, ensureLocalConfigIgnored, initNextCommands, initTips } from '../src/init.js';
import { SandboxConfigSchema } from '../src/config.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'sbx-init-'));
}

describe('applyHostGroups', () => {
  const cfg = () => SandboxConfigSchema.parse({});

  it('adds the build-tools bundle to egress.allow and reports what was added', () => {
    const config = cfg();
    const added = applyHostGroups(config, ['build-tools']);
    expect(added).toContain('nodejs.org');
    expect(added).toContain('github.com');
    expect(config.egress.allow).toEqual(expect.arrayContaining(['npmjs.org', 'nodejs.org', 'github.com']));
  });

  it('is a no-op for an empty selection or an unknown group', () => {
    expect(applyHostGroups(cfg(), [])).toEqual([]);
    expect(applyHostGroups(cfg(), ['does-not-exist'])).toEqual([]);
  });

  it('never duplicates a host already in the allowlist', () => {
    const config = SandboxConfigSchema.parse({ egress: { allow: ['npmjs.org', 'nodejs.org'] } });
    expect(applyHostGroups(config, ['build-tools'])).not.toContain('nodejs.org');
  });
});

describe('ensureLocalConfigIgnored', () => {
  it('creates .gitignore with the local override entry when none exists', () => {
    const dir = tmp();
    expect(ensureLocalConfigIgnored(dir)).toBe(true);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('sandbox.config.local.json');
  });

  it('appends to an existing .gitignore without clobbering it', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    expect(ensureLocalConfigIgnored(dir)).toBe(true);
    const body = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(body).toContain('node_modules');
    expect(body).toContain('sandbox.config.local.json');
  });

  it('is idempotent, no change when the entry is already present', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.gitignore'), 'sandbox.config.local.json\n');
    expect(ensureLocalConfigIgnored(dir)).toBe(false);
  });

  it('does not create a .gitignore for an unrelated call path', () => {
    const dir = tmp();
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(false); // sanity: starts clean
    ensureLocalConfigIgnored(dir);
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
  });
});

describe('initNextCommands', () => {
  it('suggests install + test for balanced and strict presets', () => {
    for (const preset of ['balanced', 'strict'] as const) {
      const cmds = initNextCommands(preset);
      expect(cmds).toContain('sandbox check zod');
      expect(cmds).toContain('sandbox install');
      expect(cmds).toContain('sandbox test');
    }
  });

  it('suggests install + run dev for vibe, agent, and trusted presets', () => {
    for (const preset of ['vibe', 'agent', 'trusted'] as const) {
      const cmds = initNextCommands(preset);
      expect(cmds).toContain('sandbox check zod');
      expect(cmds).toContain('sandbox install');
      expect(cmds).toContain('sandbox dev');
    }
  });
});

describe('initTips', () => {
  it('offers the preflight and per-PM-binary tips for every preset', () => {
    for (const preset of ['balanced', 'strict', 'vibe', 'agent', 'trusted'] as const) {
      const tips = initTips(preset, 'pnpm');
      expect(tips.some((t) => t.includes('sandbox-pnpm') || t.includes('spnpm'))).toBe(true);
      expect(tips.some((t) => t.includes('path install'))).toBe(false);
    }
  });

  it('adds the devcontainer tip only for the agent preset', () => {
    expect(initTips('agent', 'pnpm').some((t) => t.includes('devcontainer'))).toBe(true);
    for (const preset of ['balanced', 'strict', 'vibe', 'trusted'] as const) {
      expect(initTips(preset, 'pnpm').some((t) => t.includes('devcontainer'))).toBe(false);
    }
  });
});
