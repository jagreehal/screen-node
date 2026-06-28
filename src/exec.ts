import { spawn } from 'node:child_process';

/** Run a command with inherited stdio; resolves with its exit code. */
export function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/** Run a command silently; resolves with its exit code, never rejects. */
export function quiet(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command capturing stdout/stderr; resolves with the result, never rejects. */
export function capture(bin: string, args: string[]): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
