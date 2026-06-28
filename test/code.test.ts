import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContainerBackend } from '../src/backend.js';
import { runCode } from '../src/code.js';
import type { CaptureResult } from '../src/exec.js';
import type { RunOverride } from '../src/backend.js';
import type { RunPlan } from '../src/plan.js';

interface Capture {
  plan: RunPlan;
  override: RunOverride | undefined;
  /** Contents of the workspace files at run time — proves the snippet + extras were laid down. */
  workspace: Record<string, string>;
}

interface FakeOptions {
  result?: CaptureResult;
  denied?: string[];
  /** Make the captured run take this long, so tests can exercise the wall-clock timeout cross-check. */
  delayMs?: number;
}

/** A backend that records the plan it's handed and returns canned output — drives runCode with no daemon. */
function fakeBackend(opts: FakeOptions = {}) {
  const captures: Capture[] = [];
  const allowed: string[][] = [];
  const result = opts.result ?? { code: 0, stdout: 'ok\n', stderr: '' };
  const record = async (plan: RunPlan, override: RunOverride | undefined): Promise<CaptureResult> => {
    const source = plan.mounts.find((m) => m.target === '/workspace')?.source ?? '';
    const workspace: Record<string, string> = {};
    for (const file of ['main.mjs', 'main.mts', 'util.mjs', 'nested/dep.mjs']) {
      const full = path.join(source, file);
      if (existsSync(full)) workspace[file] = readFileSync(full, 'utf8');
    }
    captures.push({ plan, override, workspace });
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    return result;
  };
  const backend: ContainerBackend = {
    bin: 'docker',
    ensureImage: async () => {},
    buildImages: async () => 0,
    runPlan: async () => result.code,
    runPlanCaptured: (plan, override) => record(plan, override),
    withEgress: async (allow, fn, onDenials) => {
      allowed.push(allow);
      if (opts.denied?.length) onDenials?.(opts.denied);
      return fn({ network: 'container:proxy', proxyEnv: { HTTP_PROXY: 'http://proxy' } });
    },
  };
  return { backend, captures, allowed };
}

const only = (captures: Capture[]): Capture => {
  expect(captures).toHaveLength(1);
  return captures[0]!;
};

describe('runCode', () => {
  it('runs a JS snippet under a timeout and returns captured output', async () => {
    const { backend, captures } = fakeBackend({ result: { code: 0, stdout: '2\n', stderr: '' } });
    const result = await runCode('console.log(1 + 1)', {}, backend);

    expect(result).toMatchObject({ stdout: '2\n', stderr: '', exitCode: 0, timedOut: false, deniedHosts: [] });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const { plan, override, workspace } = only(captures);
    expect(plan.argv).toEqual(['timeout', '-k', '2', '10', 'node', 'main.mjs']);
    expect(workspace['main.mjs']).toBe('console.log(1 + 1)');
    expect(plan.interactive).toBe(false); // captured runs must not allocate a TTY
    expect(plan.network).toBe('none'); // untrusted code gets no network by default
    expect(override?.network).toBe('none');
  });

  it('runs TypeScript via the .mts entry (Node strips types, no tsx, no network)', async () => {
    const { backend, captures } = fakeBackend();
    await runCode('const n: number = 2; console.log(n)', { language: 'ts' }, backend);
    const { plan, workspace } = only(captures);
    expect(plan.argv).toEqual(['timeout', '-k', '2', '10', 'node', 'main.mts']);
    expect(workspace['main.mts']).toContain('const n: number');
    expect(workspace['main.mjs']).toBeUndefined();
  });

  it('maps timeoutMs to fractional seconds for timeout(1)', async () => {
    const { backend, captures } = fakeBackend();
    await runCode('1', { timeoutMs: 1500 }, backend);
    expect(only(captures).plan.argv).toContain('1.5');
  });

  it('flags timedOut when exit 124 coincides with reaching the deadline', async () => {
    const { backend } = fakeBackend({ result: { code: 124, stdout: '', stderr: '' }, delayMs: 40 });
    const result = await runCode('while (true) {}', { timeoutMs: 10 }, backend);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it('flags timedOut on SIGKILL escalation (exit 137), code that traps SIGTERM', async () => {
    const { backend } = fakeBackend({ result: { code: 137, stdout: '', stderr: '' }, delayMs: 40 });
    const result = await runCode("process.on('SIGTERM', () => {}); while (true) {}", { timeoutMs: 10 }, backend);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(137);
  });

  it('does NOT treat a snippet that exits 124 early as a timeout', async () => {
    // The run returns immediately, well under the deadline — exit 124 alone must not imply a timeout.
    const { backend } = fakeBackend({ result: { code: 124, stdout: '', stderr: '' } });
    const result = await runCode('process.exit(124)', { timeoutMs: 10_000 }, backend);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(124);
  });

  it('does not flag timedOut for ordinary non-zero exits', async () => {
    const { backend } = fakeBackend({ result: { code: 1, stdout: '', stderr: 'boom\n' } });
    const result = await runCode('process.exit(1)', {}, backend);
    expect(result.timedOut).toBe(false);
    expect(result).toMatchObject({ exitCode: 1, stderr: 'boom\n' });
  });

  it('writes extra files (including nested) so the snippet can import them', async () => {
    const { backend, captures } = fakeBackend();
    await runCode("import './util.mjs'", { files: { 'util.mjs': 'export const x = 1', 'nested/dep.mjs': 'export const y = 2' } }, backend);
    const { workspace } = only(captures);
    expect(workspace['util.mjs']).toBe('export const x = 1');
    expect(workspace['nested/dep.mjs']).toBe('export const y = 2');
  });

  it('forwards caller env but never the host environment', async () => {
    process.env.SBX_CODE_SECRET = 'leaked';
    try {
      const { backend, captures } = fakeBackend();
      await runCode('1', { env: { GREETING: 'hi' } }, backend);
      const { plan } = only(captures);
      expect(plan.env.GREETING).toBe('hi');
      expect(plan.env.SANDBOX).toBe('1');
      expect(plan.env.SBX_CODE_SECRET).toBeUndefined();
    } finally {
      delete process.env.SBX_CODE_SECRET;
    }
  });

  it('routes allowlist egress through the proxy and reports blocked hosts', async () => {
    const { backend, captures, allowed } = fakeBackend({ denied: ['evil.example'] });
    const result = await runCode('fetch("https://evil.example")', { network: 'allowlist', allow: ['api.example.com'] }, backend);
    expect(result.deniedHosts).toEqual(['evil.example']);
    expect(allowed).toEqual([['api.example.com']]);
    expect(only(captures).plan.network).toBe('allowlist');
  });

  it('cleans up the throwaway workspace afterwards', async () => {
    const { backend, captures } = fakeBackend();
    await runCode('1', {}, backend);
    const source = only(captures).plan.mounts.find((m) => m.target === '/workspace')?.source;
    expect(source).toBeTruthy();
    expect(existsSync(source!)).toBe(false);
  });

  it('rejects a non-positive timeout', async () => {
    const { backend } = fakeBackend();
    await expect(runCode('1', { timeoutMs: 0 }, backend)).rejects.toThrow(/positive number/);
  });

  it('rejects file paths that escape the workspace', async () => {
    const { backend } = fakeBackend();
    await expect(runCode('1', { files: { '../escape.mjs': 'x' } }, backend)).rejects.toThrow(/unsafe file path/);
    await expect(runCode('1', { files: { '/abs.mjs': 'x' } }, backend)).rejects.toThrow(/unsafe file path/);
  });
});
