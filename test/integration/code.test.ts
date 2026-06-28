import { beforeAll, describe, expect, it } from 'vitest';
import { runCode } from '../../src/code.js';
import { PACKAGE_ROOT, dockerAvailable, runCli } from './helpers.js';

const hasDocker = dockerAvailable();

// Real container execution: proves the agent code-exec API actually isolates, captures, and kills.
describe.skipIf(!hasDocker)('runCode (docker integration)', () => {
  beforeAll(async () => {
    const { code } = await runCli(PACKAGE_ROOT, ['build']);
    expect(code).toBe(0);
  }, 600_000);

  it('runs JavaScript and captures stdout', async () => {
    const result = await runCode("console.log('hello from sandbox')");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from sandbox\n');
    expect(result.timedOut).toBe(false);
  });

  it('runs TypeScript via Node type-stripping (no tsx, no network)', async () => {
    const result = await runCode('const n: number = 21; console.log(n * 2)', { language: 'ts' });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('42\n');
  });

  it('captures stderr and the real exit code', async () => {
    const result = await runCode("console.error('nope'); process.exit(3)");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('nope');
  });

  it('kills an infinite loop at the timeout (the boundary vm timeouts cannot enforce)', async () => {
    const result = await runCode('while (true) {}', { timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    // Killed near the deadline, not left running for the full default budget.
    expect(result.durationMs).toBeLessThan(15_000);
  });

  it('still times out code that traps SIGTERM, escalates to SIGKILL (exit 137)', async () => {
    const result = await runCode("process.on('SIGTERM', () => {});\nwhile (true) {}", { timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(137); // 128 + SIGKILL — `timeout -k` had to escalate
    expect(result.durationMs).toBeLessThan(15_000);
  });

  it('has no network by default, outbound connections fail', async () => {
    const result = await runCode("try { await fetch('https://example.com'); console.log('REACHED'); } catch { console.log('BLOCKED'); }");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('BLOCKED');
  });

  it('lets the snippet import extra files written into the workspace', async () => {
    const result = await runCode("import { answer } from './lib.mjs';\nconsole.log(answer)", {
      files: { 'lib.mjs': 'export const answer = 7;' },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('7\n');
  });

  it('does not mount host credentials into the box', async () => {
    const result = await runCode("import { existsSync } from 'node:fs';\nconsole.log(existsSync('/root/.aws') || existsSync('/root/.ssh') ? 'PRESENT' : 'ABSENT')");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('ABSENT');
  });
});
