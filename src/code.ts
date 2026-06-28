import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend, type ContainerBackend } from './backend.js';
import { SandboxConfigSchema, type NetworkMode } from './config.js';
import { execute } from './execute.js';
import { planRun } from './plan.js';
import { probeProject } from './project.js';

/**
 * Language of the snippet. Both run on plain Node — TypeScript is executed by Node's built-in
 * type stripping (Node ≥22.6 / on by default in 24), so no `tsx`, no compiler, and no network
 * fetch is needed. Use erasable (type-stripping) TypeScript: types, interfaces, and annotations
 * are fine; `enum`/`namespace` and other transform-requiring syntax are not.
 */
export type CodeLanguage = 'js' | 'ts';

export interface RunCodeOptions {
  /** Snippet language. Default `'js'`. */
  language?: CodeLanguage;
  /**
   * Network for the run. Default `'none'` — the box has no network interface at all, the right
   * default for untrusted/generated code. `'allowlist'` routes egress through the default-deny
   * proxy ({@link RunCodeOptions.allow} names the permitted hosts); `'on'` is the open bridge.
   */
  network?: NetworkMode;
  /** Hosts the code may reach when `network: 'allowlist'`. Anything else is blocked (and reported in {@link RunCodeResult.deniedHosts}). */
  allow?: string[];
  /** Wall-clock budget. When it elapses the container is killed (SIGTERM, then SIGKILL); the result is flagged `timedOut`. Default 10000ms. */
  timeoutMs?: number;
  /** Extra files to drop alongside the entry file (relative paths, e.g. `{ 'util.mjs': '...' }`) so the snippet can import them. */
  files?: Record<string, string>;
  /** Environment variables visible to the snippet. The host's environment is never forwarded. */
  env?: Record<string, string>;
  /** Container runtime. Default `'docker'`. */
  backend?: 'docker' | 'podman';
  /** Sandbox image tag to run. Default the bundled image (built on first use). */
  image?: string;
}

export interface RunCodeResult {
  /** Everything the snippet wrote to stdout. */
  stdout: string;
  /** Everything the snippet wrote to stderr (including the runtime's own error output). */
  stderr: string;
  /** The process exit code. `124` is the timeout sentinel — see {@link RunCodeResult.timedOut}. */
  exitCode: number;
  /** True when the run was killed for exceeding {@link RunCodeOptions.timeoutMs}. */
  timedOut: boolean;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  /** Hosts the egress guard blocked (only ever non-empty under `network: 'allowlist'`). */
  deniedHosts: string[];
}

/** ESM entry filename per language — `.mjs`/`.mts` so both run as modules (top-level await, `import`). */
const ENTRY: Record<CodeLanguage, string> = { js: 'main.mjs', ts: 'main.mts' };

/**
 * Exit codes GNU `timeout` produces when it had to kill the command: 124 when the command died to the
 * first signal (SIGTERM), or 137 (128 + SIGKILL) when the command trapped SIGTERM and `-k` had to
 * escalate. We pair this with a wall-clock check so a snippet that *chooses* one of these codes early
 * (e.g. `process.exit(137)`, or its own OOM kill) isn't mistaken for a timeout.
 */
const TIMEOUT_KILL_CODES = new Set([124, 137]);

/** Seconds `timeout` waits after SIGTERM before escalating to SIGKILL (defeats code that traps SIGTERM). */
const KILL_GRACE_SECONDS = 2;

/** A caller-supplied file path is safe when it stays inside the workspace (no absolute path, no `..` escape). */
function isSafeWorkspacePath(name: string): boolean {
  if (name.length === 0 || path.isAbsolute(name)) return false;
  const normalized = path.normalize(name);
  return normalized !== '.' && !normalized.startsWith('..');
}

/**
 * Lay out the throwaway workspace on the host: the entry file holding `code`, plus any extra
 * `files`. The entry is written last so it always wins a name collision (the snippet is authoritative).
 */
function writeWorkspace(dir: string, entry: string, code: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    if (!isSafeWorkspacePath(name)) throw new Error(`runCode: unsafe file path '${name}' (must be relative and stay inside the workspace)`);
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  writeFileSync(path.join(dir, entry), code);
}

/**
 * Run a snippet of JavaScript or TypeScript inside the sandbox and return its captured output.
 *
 * This is the agent-facing code-execution API: unlike `vm.runInThisContext` or the old in-process
 * "sandbox" packages (which Node's own docs warn are NOT security boundaries — a one-line escape
 * reaches the host), the code runs in a throwaway container with no host credentials mounted and,
 * by default, no network at all. The wall-clock timeout is enforced by `timeout(1)` running as the
 * container's init process, a separate process from your code, so a `while (true) {}` can't block,
 * clear, or outlast it the way it defeats a `vm` timeout. (It is in-container enforcement, not an
 * external host supervisor; there is no separate host-side hard cap.)
 *
 * It is OS/container isolation, not a hypervisor: the kernel is shared, so treat genuinely hostile,
 * multi-tenant workloads as needing a microVM underneath. For running model-generated code, it's the
 * right boundary.
 *
 * @example
 * const { stdout, exitCode } = await runCode('console.log(1 + 1)');
 * // stdout === '2\n', exitCode === 0
 */
export async function runCode(
  code: string,
  options: RunCodeOptions = {},
  // Defaults to a real docker/podman backend; injectable so tests can drive the plan without a daemon
  // (the same seam `execute` exposes).
  backend: ContainerBackend = createBackend(options.backend ?? 'docker'),
): Promise<RunCodeResult> {
  const { language = 'js', network = 'none', allow = [], timeoutMs = 10_000, files = {}, env = {} } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`runCode: timeoutMs must be a positive number (got ${timeoutMs})`);

  // `image: undefined` falls through to the schema's default tag — so the rest of the plan pipeline
  // reads one resolved config and never has to special-case an unset image.
  const config = SandboxConfigSchema.parse({ image: options.image, run: { network }, egress: { allow } });
  const entry = ENTRY[language];

  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-code-'));
  try {
    writeWorkspace(dir, entry, code, files);
    // probeProject reads the host environment into `facts.hostEnv`, but planRun only forwards env
    // names listed in `config.grants.env` — empty here — so none of the host's environment can reach
    // the box. That empty grant list is the load-bearing invariant; the caller's `env` is added below.
    const facts = probeProject(dir, config);
    // `timeout` runs as the container's init process (the parent of `node`, not the snippet itself):
    // SIGTERM at the deadline, then SIGKILL after a grace window. Because it's a separate process, a
    // busy loop can't block, clear, or outrun it — and killing it (PID 1) just tears down the container.
    const argv = ['timeout', '-k', String(KILL_GRACE_SECONDS), String(timeoutMs / 1000), 'node', entry];
    const base = planRun(config, facts, argv);
    // Non-interactive (no TTY) so stdout/stderr stay separable when captured; merge in the caller's env.
    const plan = { ...base, interactive: false, env: { ...base.env, ...env } };

    // Warm the image first so `durationMs` measures the run itself, not a one-time image build — and
    // so the timeout cross-check below can't be fooled by a long first build.
    await backend.ensureImage(plan.build);
    const startedAt = Date.now();
    const result = await execute(plan, backend, { capture: true });
    const durationMs = Date.now() - startedAt;

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.code,
      // A timeout is a kill-code AND a run that actually reached the deadline — neither alone is enough
      // (a snippet can pick a kill-code itself; a slow-but-clean run can reach the deadline and exit 0).
      timedOut: TIMEOUT_KILL_CODES.has(result.code) && durationMs >= timeoutMs,
      durationMs,
      deniedHosts: result.deniedHosts,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
