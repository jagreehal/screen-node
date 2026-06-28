import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SandboxConfig } from './config.js';
import { loadEnvFiles } from './env-files.js';
import { isYarnBerry, lockfilePresent, resolvePackageManager, type PackageManager } from './package-manager.js';

/**
 * Auto-execution / persistence vectors a hostile postinstall would use to re-run
 * itself (the worm's step). The prober reports which exist on the host; the planner
 * forces them read-only during install/add — bound ro when present, blocked by a
 * read-only volume when absent.
 */
export const PERSISTENCE_PATHS = ['.git', '.github', '.gitlab', '.husky', '.claude', '.cursor', '.gemini', '.vscode'];

/** Per-invocation inputs that decide which host files the prober must read. */
export interface ProbeOptions {
  /** Extra env files to parse on the host (added to `config.grants.envFiles`). */
  envFiles?: string[];
  /** Base directory for relative per-invocation env-file paths. Defaults to the probed `cwd`. */
  envFileBaseDir?: string;
  /** Base directory for relative `config.grants.envFiles`. Defaults to the probed `cwd`. */
  configEnvFilesBaseDir?: string;
}

export interface DirectDependency {
  name: string;
  spec: string;
}

/**
 * Everything `plan*()` needs to know about the host, captured once. With facts in
 * hand the planners are pure data→data: same facts ⇒ same plan, no fs/env reads.
 */
export interface ProjectFacts {
  /** Project root the plan's host paths are built from. */
  cwd: string;
  /** Detected package manager (npm fallback). */
  pm: PackageManager;
  /** Yarn Berry (>=2) — selects `--immutable` over `--frozen-lockfile`. */
  isYarnBerry: boolean;
  /** The pm's lockfile is present (gates locking it during a frozen pnpm install). */
  hasLockfile: boolean;
  /** `package.json` is present (gates the read-only manifest mount). */
  hasPackageJson: boolean;
  /** The root manifest's `scripts` map ({} when absent) — what `sandbox <script>`/`sandbox dev` route against. */
  scripts: Record<string, string>;
  /**
   * Direct dependencies the supply-chain gates should check. For a single package that's the root
   * manifest's deps/devDeps/optionalDeps; for a workspace it's the UNION across the root and every
   * workspace package (deduped by name) — because `install` at the root pulls them all, so checking
   * only the root manifest (usually just build tooling) would miss the real surface.
   */
  directDependencies: DirectDependency[];
  /** Subset of {@link PERSISTENCE_PATHS} that exist on disk (bound ro; the rest blocked). */
  existingPersistencePaths: string[];
  /** Host home directory — for `~` expansion and the home Claude grant. */
  homedir: string;
  /** Host environment — the source for named env-var grants. */
  hostEnv: Record<string, string | undefined>;
  /** Values parsed from configured + per-invocation env files. */
  envFileValues: Record<string, string>;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
}

/** The root manifest's `scripts` map ({} when absent or unreadable) — the source for `sandbox <script>` routing. */
function readPackageScripts(cwd: string): Record<string, string> {
  const file = path.join(cwd, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const scripts = (JSON.parse(readFileSync(file, 'utf8')) as PackageManifest).scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

/**
 * The direct dependencies declared in a specific manifest FILE (deps + devDeps + optionalDeps,
 * deduped by name). Used both for the project probe and to audit a `package.json` passed explicitly
 * to `sandbox check <file>.json`. Returns [] for a missing/unreadable file.
 */
export function readManifestDependencies(file: string): DirectDependency[] {
  if (!existsSync(file)) return [];
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as PackageManifest;
    const byName = new Map<string, string>();
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) {
      for (const [name, spec] of Object.entries(section ?? {})) {
        if (!byName.has(name)) byName.set(name, spec);
      }
    }
    return [...byName.entries()].map(([name, spec]) => ({ name, spec }));
  } catch {
    return [];
  }
}

function readDirectDependencies(cwd: string): DirectDependency[] {
  return readManifestDependencies(path.join(cwd, 'package.json'));
}

/**
 * Returns just the package names from the root manifest's direct dependencies
 * (deps + devDeps + optionalDeps), for scan's direct-vs-transitive tagging.
 */
export function readDirectDependencyNames(cwd: string): string[] {
  return readDirectDependencies(cwd).map((d) => d.name);
}

function unquote(value: string): string {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

/** The `packages:` sequence from a pnpm-workspace.yaml (a simple top-level list of globs). */
function parsePnpmWorkspacePackages(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item) {
      out.push(unquote(item[1]!));
      continue;
    }
    if (/^\S/.test(line)) break; // next top-level key ends the sequence
  }
  return out;
}

/** Workspace package globs from package.json `workspaces` (array or `{packages}`) and pnpm-workspace.yaml. */
function workspaceGlobs(rootDir: string): string[] {
  const globs: string[] = [];
  const pkgFile = path.join(rootDir, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const ws = (JSON.parse(readFileSync(pkgFile, 'utf8')) as PackageManifest).workspaces;
      if (Array.isArray(ws)) globs.push(...ws);
      else if (ws && Array.isArray(ws.packages)) globs.push(...ws.packages);
    } catch {
      // unreadable manifest — fall through to pnpm-workspace.yaml
    }
  }
  const pnpmFile = path.join(rootDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) {
    try {
      globs.push(...parsePnpmWorkspacePackages(readFileSync(pnpmFile, 'utf8')));
    } catch {
      // unreadable workspace file — ignore
    }
  }
  return globs;
}

/** Expand one workspace glob to package directories. Handles `dir/*` and exact paths; skips `!` negations. */
function expandWorkspaceGlob(rootDir: string, glob: string): string[] {
  if (glob.startsWith('!')) return []; // pnpm negation globs aren't supported; ignore rather than mis-expand
  const hasPackageJson = (dir: string): boolean => existsSync(path.join(dir, 'package.json'));
  if (glob.endsWith('/*')) {
    const base = path.join(rootDir, glob.slice(0, -2));
    if (!existsSync(base)) return [];
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(base, d.name))
        .filter(hasPackageJson);
    } catch {
      return [];
    }
  }
  const dir = path.join(rootDir, glob);
  return hasPackageJson(dir) ? [dir] : [];
}

/**
 * Direct deps across the whole workspace: the root manifest plus every workspace package's manifest,
 * deduped by name (first wins). A non-workspace project yields just the root manifest's deps, so this
 * is a no-op there. Local (`workspace:`/`file:`/`link:`) specs survive here but are dropped when the
 * risk targets are built — see `riskTargetsForInstall`.
 */
export function readWorkspaceDependencies(rootDir: string): DirectDependency[] {
  const dirs = [rootDir];
  for (const glob of workspaceGlobs(rootDir)) dirs.push(...expandWorkspaceGlob(rootDir, glob));
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    for (const { name, spec } of readDirectDependencies(dir)) {
      if (!byName.has(name)) byName.set(name, spec);
    }
  }
  return [...byName.entries()].map(([name, spec]) => ({ name, spec }));
}

/**
 * Read the host once and freeze it into {@link ProjectFacts}. This is the ONE impure
 * seam in front of the planners — everything they would otherwise stat, expand, or
 * read from the environment is resolved here.
 */
export function probeProject(cwd: string, config: SandboxConfig, opts: ProbeOptions = {}): ProjectFacts {
  const pm = resolvePackageManager(cwd);
  const configEnvFileValues = loadEnvFiles(config.grants.envFiles, opts.configEnvFilesBaseDir ?? cwd);
  const invocationEnvFileValues = loadEnvFiles(opts.envFiles ?? [], opts.envFileBaseDir ?? cwd);
  return {
    cwd,
    pm,
    isYarnBerry: isYarnBerry(cwd),
    hasLockfile: lockfilePresent(cwd, pm),
    hasPackageJson: existsSync(path.join(cwd, 'package.json')),
    scripts: readPackageScripts(cwd),
    directDependencies: readWorkspaceDependencies(cwd),
    existingPersistencePaths: PERSISTENCE_PATHS.filter((p) => existsSync(path.join(cwd, p))),
    homedir: os.homedir(),
    hostEnv: process.env,
    envFileValues: { ...configEnvFileValues, ...invocationEnvFileValues },
  };
}
