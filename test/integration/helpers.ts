import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
function resolveCli(): string {
  const esm = path.join(ROOT, 'dist', 'cli.mjs');
  return existsSync(esm) ? esm : path.join(ROOT, 'dist', 'cli.js');
}

export const CLI = resolveCli();
export const PACKAGE_ROOT = ROOT;
function resolveTsxCli(): string {
  const packageJsonPath = require.resolve('tsx/package.json', { paths: [ROOT] });
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.tsx;
  if (!bin) throw new Error('Could not resolve tsx bin entry');
  return path.join(packageDir, bin);
}
const TSX = resolveTsxCli();

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI in `cwd` and capture its output. */
export function runCli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    // Scrub SANDBOX_OFF from the inherited env: the CLI now honours it (off → run on the host), so a
    // dev/CI shell that happens to export it would otherwise turn EVERY containment test into a
    // passthrough. Tests that exercise the off path re-add it via the `env` override below.
    const baseEnv = { ...process.env };
    delete baseEnv.SANDBOX_OFF;
    const child = spawn(process.execPath, [resolveCli(), ...args], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Run a repo-local TypeScript script with tsx while targeting a fixture cwd. */
export function runRepoScript(cwd: string, scriptRel: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, path.join(PACKAGE_ROOT, scriptRel)], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

let dockerCache: boolean | undefined;
/** True if a docker daemon is reachable (so Docker tests can run). */
export function dockerAvailable(): boolean {
  if (dockerCache === undefined) {
    dockerCache = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  }
  return dockerCache;
}

/** Create a throwaway project dir seeded with `files`. */
export function fixture(files: Record<string, string>): string {
  // realpath so it matches process.cwd() inside the CLI (macOS /var -> /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sbx-it-')));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

/** A fixture whose dependency runs a probe at postinstall (harvest + persistence + egress). */
export function probeFixture(config: object): string {
  const probe = `
const fs = require('fs'), os = require('os'), path = require('path');
let creds = 0;
for (const r of ['.ssh/id_ed25519', '.npmrc', '.aws/credentials']) {
  try { fs.accessSync(path.join(os.homedir(), r)); creds++; } catch {}
}
let persist = false;
try { fs.mkdirSync('/workspace/.github', { recursive: true }); fs.writeFileSync('/workspace/.github/persist.yml', 'x'); persist = true; } catch {}
console.log('PROBE creds=' + creds + ' persist=' + (persist ? 'WROTE' : 'BLOCKED'));
require('dns').lookup('example.com', (e) => console.log('PROBE egress=' + (e ? 'BLOCKED' : 'REACHED')));
`;
  return fixture({
    'package.json': JSON.stringify({
      name: 'probe-fixture',
      private: true,
      dependencies: { 'bad-dep': 'file:./bad-dep' },
    }),
    'sandbox.config.json': JSON.stringify(config),
    'bad-dep/package.json': JSON.stringify({
      name: 'bad-dep',
      version: '1.0.0',
      scripts: { postinstall: 'node probe.js' },
    }),
    'bad-dep/probe.js': probe,
  });
}
