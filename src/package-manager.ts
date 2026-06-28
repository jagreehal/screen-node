import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type InstallMode = 'install' | 'add' | 'remove';

/**
 * True when a token is a bare package-manager name. Used to tell the explicit `sandbox <pm>` passthrough
 * (force the container) from the friendly verbs and the `sandbox-<pm>` bins (mode-aware install).
 */
export function isPackageManagerName(name: string): name is PackageManager {
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun';
}

const LOCKFILES: Record<PackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};

/** bun writes either the text `bun.lock` (default since 1.2) or the legacy binary `bun.lockb`. */
const BUN_LOCKFILES = ['bun.lock', 'bun.lockb'] as const;

const EXACT_FLAGS = new Set(['--save-exact', '--exact', '-E', '-e']);
const YARN_RANGE_FLAGS = new Set(['--caret', '-C', '--tilde', '-T', '--exact', '-E']);

function lockfileCandidates(pm: PackageManager): readonly string[] {
  return pm === 'bun' ? BUN_LOCKFILES : [LOCKFILES[pm]];
}

export interface ParsedPackageManager {
  name: PackageManager;
  /** Version with any `+sha…` integrity suffix stripped (for comparisons). */
  version: string;
  /** The raw `packageManager` field, integrity hash included — pass this to `corepack prepare`. */
  raw: string;
}

const PACKAGE_MANAGER_RE = /^(npm|pnpm|yarn|bun)@([0-9A-Za-z][0-9A-Za-z._+-]*)$/;

/**
 * Parse a package.json `packageManager` field (e.g. `pnpm@9.15.0`,
 * `pnpm@9.15.0+sha512.…`). Returns null when absent or not a known manager.
 */
export function parsePackageManagerField(field: unknown): ParsedPackageManager | null {
  if (typeof field !== 'string') return null;
  const match = PACKAGE_MANAGER_RE.exec(field);
  if (!match) return null;
  const name = match[1];
  const rawVersion = match[2];
  if (!name || !rawVersion) return null;
  const version = rawVersion.split('+')[0];
  if (!version) return null;
  return { name: name as PackageManager, version, raw: field };
}

function packageManagerFromManifest(cwd: string): PackageManager | undefined {
  const file = path.join(cwd, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // Standard `packageManager` field (e.g. "pnpm@11.5.3")
    const fromPm = parsePackageManagerField(raw.packageManager);
    if (fromPm) return fromPm.name;
    // devEngines spec (e.g. { "packageManager": { "name": "pnpm" } })
    const dePm = raw.devEngines?.packageManager;
    if (dePm && typeof dePm.name === 'string') {
      const name = dePm.name.toLowerCase();
      if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Detect the package manager from the lockfile present in `cwd` (npm fallback). */
export function resolvePackageManager(cwd: string): PackageManager {
  const fromManifest = packageManagerFromManifest(cwd);
  if (fromManifest) return fromManifest;
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (BUN_LOCKFILES.some((f) => existsSync(path.join(cwd, f)))) return 'bun';
  return 'npm';
}

/** The canonical lockfile name for messages (bun reports the modern `bun.lock`). */
export function lockfileName(pm: PackageManager): string {
  return LOCKFILES[pm];
}

/** Whether a committed lockfile is present — accepts either bun spelling. */
export function lockfilePresent(cwd: string, pm: PackageManager): boolean {
  return lockfileCandidates(pm).some((f) => existsSync(path.join(cwd, f)));
}

function defaultExactArgs(pm: PackageManager, args: string[]): string[] {
  if (pm === 'yarn') {
    return args.some((a) => YARN_RANGE_FLAGS.has(a)) ? args : ['--exact', ...args];
  }
  return args.some((a) => EXACT_FLAGS.has(a))
    ? args
    : [pm === 'bun' ? '--exact' : '--save-exact', ...args];
}

/**
 * The command to run inside the container. npm uses `install` for both install/add
 * (`npm install <pkg>` adds) and `uninstall` to drop a dep; pnpm/yarn/bun use `add` / `remove`.
 * Dependency adds are saved as exact versions by default across all package managers (explicit
 * yarn range flags still win); removes pull nothing new, so no exact-version defaulting applies.
 */
export function pmArgv(pm: PackageManager, mode: InstallMode, args: string[]): string[] {
  if (mode === 'remove') {
    switch (pm) {
      case 'npm':
        return ['npm', 'uninstall', ...args];
      case 'pnpm':
        return ['corepack', 'pnpm', 'remove', ...args];
      case 'yarn':
        return ['corepack', 'yarn', 'remove', ...args];
      case 'bun':
        return ['bun', 'remove', ...args];
    }
  }
  const verb = mode === 'add' ? 'add' : 'install';
  const rest = mode === 'add' ? defaultExactArgs(pm, args) : args;
  switch (pm) {
    case 'npm':
      return ['npm', 'install', ...rest];
    case 'pnpm':
      return ['corepack', 'pnpm', verb, ...rest];
    case 'yarn':
      return ['corepack', 'yarn', verb, ...rest];
    case 'bun':
      return ['bun', verb, ...rest];
  }
}

/**
 * The local-first package runner for `sandbox x <tool>` — the muscle-memory shortcut for
 * `npx`/`bunx` that resolves `node_modules/.bin` first and fetches from the registry only as a
 * fallback. bun projects get `bunx` (its native runner); everyone else gets `npx`, which always
 * ships with the container's Node and works regardless of the project's package manager.
 */
export function pmExecArgv(pm: PackageManager, args: string[]): string[] {
  return pm === 'bun' ? ['bunx', ...args] : ['npx', ...args];
}

/**
 * The native way to invoke a package.json script for each package manager. npm needs `run` and
 * inserts `--` before script args; pnpm/yarn/bun can execute the script name directly.
 */
export function pmScriptArgv(pm: PackageManager, script: string, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'run', script, ...(args.length === 0 ? [] : args[0] === '--' ? args : ['--', ...args])];
    case 'pnpm':
      return ['pnpm', script, ...args];
    case 'yarn':
      return ['yarn', script, ...args];
    case 'bun':
      return ['bun', script, ...args];
  }
}

/**
 * A package manager's own default registry host, when it differs from the public npm registry that
 * is already in the default egress allowlist. Yarn classic (v1) defaults to `registry.yarnpkg.com`
 * (npm's own CDN mirror, same trust class), and that host is NOT in `.npmrc`, so it can't be
 * auto-detected like a private registry; without it a plain `yarn install` is blocked on first run.
 * npm/pnpm/bun all default to `registry.npmjs.org`, already covered. Returns undefined when nothing
 * extra is needed. Other registries (jsr.io, npmmirror) stay opt-in via the prompt / `sandbox allow`.
 */
export function pmDefaultRegistryHost(pm: PackageManager): string | undefined {
  return pm === 'yarn' ? 'yarnpkg.com' : undefined;
}

/** Yarn Berry (>=2) projects carry a .yarnrc.yml and use `--immutable`, not `--frozen-lockfile`. */
export function isYarnBerry(cwd: string): boolean {
  return existsSync(path.join(cwd, '.yarnrc.yml'));
}

/**
 * The container path each package manager keeps its download cache / content store in (under
 * `HOME=/root`). Persisting this in a named volume across runs avoids re-downloading tarballs; it
 * lives outside `/workspace`, so it works even under a fully read-only `--frozen` tree.
 *
 * Why a single shared (per-manager) volume is sound: every entry is **content-addressed** — the
 * key is the package's integrity hash (npm cacache / pnpm store / yarn / bun all do this). A
 * tampered entry hashes to a different key, so it can't be substituted for the real package and a
 * mismatched entry is refetched. That's the cache-*poisoning* threat closed, and it's exactly how
 * these tools natively share one global store across every project on a dev machine. It does NOT
 * isolate *contents* between repos: a sandboxed install in one repo can read private-registry
 * tarballs another repo cached here (default-deny egress still stops it leaving). For installs that
 * must be fully isolated from each other, set `install.cache: false`.
 */
export function packageManagerCacheDir(pm: PackageManager): string {
  switch (pm) {
    case 'npm':
      return '/root/.npm';
    case 'pnpm':
      return '/root/.local/share/pnpm/store';
    case 'yarn':
      return '/root/.cache/yarn';
    case 'bun':
      return '/root/.bun/install/cache';
  }
}

/**
 * Build the update argv, preserving the verb the user typed (`npm up` vs `npm update`, `yarn
 * upgrade` vs `yarn up`). pnpm/yarn run through corepack like the other verbs.
 */
export function pmUpdateArgv(pm: PackageManager, verb: string, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', verb, ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', verb, ...args];
    case 'yarn':
      return ['corepack', 'yarn', verb, ...args];
    case 'bun':
      return ['bun', verb, ...args];
  }
}

/**
 * The audit-fix argv for package managers that support an in-place remediation command. npm uses
 * the positional `fix` subcommand; pnpm uses `--fix` / `--fix=update`. `fixToken` is preserved so
 * callers keep the exact repair mode the user requested.
 */
export function pmAuditFixArgv(pm: PackageManager, fixToken: string, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'audit', fixToken, ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', 'audit', fixToken, ...args];
    case 'yarn':
    case 'bun':
      throw new Error(`screen: ${pm} does not support an install-class audit fix command`);
  }
}

/**
 * Read-only signature/provenance verification against the configured registries. This talks to
 * registry key endpoints but does not mutate the manifest, lockfile, or dependency tree.
 */
export function pmAuditSignaturesArgv(pm: PackageManager, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'audit', 'signatures', ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', 'audit', 'signatures', ...args];
    case 'yarn':
    case 'bun':
      throw new Error(`screen: ${pm} does not support audit signatures`);
  }
}

/**
 * Reproducible install that writes ONLY node_modules (never the lockfile): `npm ci`,
 * `pnpm install --frozen-lockfile`, `yarn --frozen-lockfile`/`--immutable`. Requires a
 * committed, in-sync lockfile. Enables a fully read-only source tree (every PM except pnpm).
 * `yarnBerry` selects Yarn 2+'s `--immutable` (probed up-front by {@link ProjectFacts}).
 */
export function frozenInstallArgv(pm: PackageManager, yarnBerry: boolean, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'ci', ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', 'install', '--frozen-lockfile', ...args];
    case 'yarn':
      return ['corepack', 'yarn', 'install', yarnBerry ? '--immutable' : '--frozen-lockfile', ...args];
    case 'bun':
      return ['bun', 'install', '--frozen-lockfile', ...args];
  }
}
