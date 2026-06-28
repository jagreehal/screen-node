import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from './helpers.js';

// Runs the examples proof runner in plan mode (no container runtime). This keeps the
// shipped example projects honest: each one must resolve to the right package manager
// *and* the expected containment boundary.
describe('examples', () => {
  it('every example resolves to the expected containment plan', () => {
    const runner = path.join(PACKAGE_ROOT, 'examples', 'run.mjs');
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/all \d+ proof checks passed/);
    expect(result.status).toBe(0);
  });
});
