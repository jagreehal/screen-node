import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type CommandKind = 'install' | 'add' | 'other';

export interface TreeSnapshot {
  files: Map<string, string>;
}

function normalize(rel: string): string {
  return rel.split(path.sep).join('/');
}

function shouldSkip(rel: string): boolean {
  const file = normalize(rel);
  // Skip any node_modules at any depth, not just the root. Workspace/monorepo installs
  // write into per-package node_modules (app/node_modules, packages/*/node_modules, …),
  // which is dependency output, not project tampering.
  return (
    file === 'node_modules' ||
    file.startsWith('node_modules/') ||
    file.endsWith('/node_modules') ||
    file.includes('/node_modules/')
  );
}

function signature(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile()) return `kind:${stat.isDirectory() ? 'dir' : 'other'}`;
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `file:${stat.mode}:${stat.size}:${hash}`;
}

function walk(root: string, rel: string, out: Map<string, string>): void {
  const full = rel ? path.join(root, rel) : root;
  if (!existsSync(full)) return;
  const stat = lstatSync(full);
  if (!rel) {
    for (const entry of readdirSync(full)) walk(root, entry, out);
    return;
  }
  if (shouldSkip(rel)) return;
  const norm = normalize(rel);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(full)) walk(root, path.join(rel, entry), out);
    return;
  }
  out.set(norm, signature(full));
}

export function snapshotTree(root: string): TreeSnapshot {
  const files = new Map<string, string>();
  walk(root, '', files);
  return { files };
}

export function classifyCommand(argv: string[]): CommandKind {
  if (argv.includes('add')) return 'add';
  if (argv.includes('install') || argv.includes('ci') || argv.includes('update') || argv.includes('up')) return 'install';
  if (argv.includes('audit') && argv.some((arg) => arg === 'fix' || arg === '--fix' || arg.startsWith('--fix='))) return 'install';
  return 'other';
}

function isExpectedProjectWrite(rel: string, kind: CommandKind): boolean {
  const file = normalize(rel);
  if (kind === 'other') return false;
  if (kind === 'add' && file === 'package.json') return true;
  if (file === 'package-lock.json' || file === 'pnpm-lock.yaml' || file === 'yarn.lock' || file === 'npm-shrinkwrap.json') return true;
  // pnpm manages its own settings in pnpm-workspace.yaml during install — it records build-script
  // approvals (allowBuilds) and release-age exclusions (minimumReleaseAgeExclude) there. Those are
  // expected install writes, not tampering, so flagging them just trains people to ignore the warning.
  if (file === 'pnpm-workspace.yaml') return true;
  if (file === '.pnp.cjs' || file === '.pnp.loader.mjs') return true;
  if (file === '.yarn/install-state.gz' || file === '.yarn/build-state.yml') return true;
  if (file.startsWith('.yarn/cache/') || file.startsWith('.yarn/unplugged/')) return true;
  // pnpm's project-local content store. pnpm relocates its store next to node_modules
  // when the configured store is on a different device than the project (always the case
  // for a bind-mounted workspace), so an install legitimately writes thousands of files
  // here — it's a normal install artifact, not tampering.
  if (file === '.pnpm-store' || file.startsWith('.pnpm-store/')) return true;
  return false;
}

/** True when this install created pnpm's project-local content store (`.pnpm-store/`). */
export function wroteProjectLocalPnpmStore(before: TreeSnapshot, after: TreeSnapshot): boolean {
  for (const file of after.files.keys()) {
    if ((file === '.pnpm-store' || file.startsWith('.pnpm-store/')) && !before.files.has(file)) return true;
  }
  return false;
}

export function summarizeUnexpectedChanges(before: TreeSnapshot, after: TreeSnapshot, kind: CommandKind): string[] {
  const changed = new Set<string>();
  for (const [file, sig] of after.files) {
    if (before.files.get(file) !== sig) changed.add(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.add(file);
  }
  return [...changed].filter((file) => !shouldSkip(file) && !isExpectedProjectWrite(file, kind)).sort();
}

/**
 * The exit code for a run that may have written to the source tree. Pure, so the tripwire rule is
 * testable. This is detection AFTER the fact, not prevention: the tree is writable by design (a package
 * manager needs a writable root), so a malicious script CAN edit `src/`. When the tripwire is armed and
 * an otherwise-clean run nonetheless touched source files, we fail it so CI or an agent notices and
 * reverts. A run that already failed keeps its own non-zero code (the source write is the lesser news).
 */
export function sourceWriteExit(code: number, unexpectedChangeCount: number, failOnSourceWrites: boolean): number {
  return failOnSourceWrites && unexpectedChangeCount > 0 && code === 0 ? 1 : code;
}
