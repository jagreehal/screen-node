import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProjectContext } from '../src/context.js';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-ctx-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe('resolveProjectContext', () => {
  it('uses the nearest sandbox.config.json as the project root', () => {
    const root = tree({
      'sandbox.config.json': '{}',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/web/package.json': '{"name":"web"}',
    });
    const pkg = path.join(root, 'packages', 'web');
    const ctx = resolveProjectContext(pkg);
    expect(ctx.rootDir).toBe(root);
    expect(ctx.configPath).toBe(path.join(root, 'sandbox.config.json'));
    expect(ctx.runWorkdir).toBe('/workspace/packages/web');
  });

  it('falls back to workspace markers when no sandbox config exists', () => {
    const root = tree({
      'turbo.json': '{}',
      'package.json': '{"workspaces":["apps/*"]}',
      'apps/api/package.json': '{"name":"api"}',
    });
    const ctx = resolveProjectContext(path.join(root, 'apps', 'api'));
    expect(ctx.rootDir).toBe(root);
    expect(ctx.configPath).toBeUndefined();
    expect(ctx.runWorkdir).toBe('/workspace/apps/api');
  });

  it('lets an explicit config path choose the root', () => {
    const root = tree({
      'monorepo/sandbox.config.json': '{}',
      'monorepo/apps/web/package.json': '{"name":"web"}',
    });
    const monorepo = path.join(root, 'monorepo');
    const ctx = resolveProjectContext(path.join(monorepo, 'apps', 'web'), path.join(monorepo, 'sandbox.config.json'));
    expect(ctx.rootDir).toBe(monorepo);
    expect(ctx.runWorkdir).toBe('/workspace/apps/web');
  });
});

