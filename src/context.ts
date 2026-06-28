import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ProjectContext {
  cwd: string;
  rootDir: string;
  configPath?: string;
  runWorkdir: string;
}

function parentDirs(start: string): string[] {
  const dirs: string[] = [];
  let cur = path.resolve(start);
  while (true) {
    dirs.push(cur);
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return dirs;
}

function hasWorkspacePackageJson(dir: string): boolean {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return false;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

function isWorkspaceRoot(dir: string): boolean {
  for (const name of ['pnpm-workspace.yaml', 'turbo.json', 'turbo.jsonc', 'nx.json', 'lerna.json', 'rush.json']) {
    if (existsSync(path.join(dir, name))) return true;
  }
  if (hasWorkspacePackageJson(dir)) return true;
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
    if (existsSync(path.join(dir, lock))) return true;
  }
  return false;
}

export function findNearestConfig(start: string): string | undefined {
  for (const dir of parentDirs(start)) {
    const file = path.join(dir, 'screen.config.json');
    if (existsSync(file)) return file;
  }
  return undefined;
}

export function findWorkspaceRoot(start: string): string | undefined {
  for (const dir of parentDirs(start)) {
    if (isWorkspaceRoot(dir)) return dir;
  }
  return undefined;
}

export function resolveProjectContext(cwd: string, explicitConfig?: string): ProjectContext {
  const absCwd = path.resolve(cwd);
  const configPath = explicitConfig ? path.resolve(explicitConfig) : findNearestConfig(absCwd);
  const rootDir = configPath ? path.dirname(configPath) : (findWorkspaceRoot(absCwd) ?? absCwd);
  const rel = path.relative(rootDir, absCwd);
  const runWorkdir = rel && rel !== '' ? `/workspace/${rel.split(path.sep).join('/')}` : '/workspace';
  return { cwd: absCwd, rootDir, configPath, runWorkdir };
}
