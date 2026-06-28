import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isCancel, multiselect } from '@clack/prompts';

const WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * When pnpm refuses to run a dependency's install script it records the package under
 * `allowBuilds:` in pnpm-workspace.yaml with a placeholder value (`set this to true or
 * false`) and exits non-zero. Any `allowBuilds` entry whose value is not literally
 * `true`/`false` is therefore an UNDECIDED build the user still has to resolve by hand —
 * which is exactly the manual step this module automates.
 */
export function parsePendingBuilds(text: string): string[] {
  const pending: string[] = [];
  let inAllowBuilds = false;
  let sectionIndent = -1;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = rawLine.match(/^\s*/u)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (inAllowBuilds && indent <= sectionIndent) {
      inAllowBuilds = false;
      sectionIndent = -1;
    }
    if (trimmed === 'allowBuilds:') {
      inAllowBuilds = true;
      sectionIndent = indent;
      continue;
    }
    if (inAllowBuilds) {
      const m = trimmed.match(/^(['"]?)(.+?)\1:\s*(.*)$/u);
      if (m) {
        const value = m[3]!.trim();
        if (value !== 'true' && value !== 'false') pending.push(m[2]!);
      }
    }
  }
  return pending;
}

/**
 * What to do about pending pnpm build scripts after an install, given the resolved inputs. Pure so the
 * decision is unit-tested once and shared by both write paths (native and contained); the caller owns
 * the file read (findPendingBuilds) and the effects (write/prompt/log).
 *   - `none`: nothing pending, or this isn't a pnpm install-class command.
 *   - `approve-all`: `--allow-all-builds` was passed, approve every pending build and re-run.
 *   - `prompt`: a TTY is available, ask which to build, then re-run.
 *   - `guide`: no TTY and no flag, print the one-line `approve-builds` guidance and surface non-zero.
 */
/**
 * Whether an argv actually runs pnpm, so build-approval keys off the package manager in the COMMAND,
 * not the repo's detected pm. Without this, `sandbox npm install` in a pnpm repo would trip pnpm's
 * build-approval state and fail with pnpm-specific guidance. pnpm argv is `pnpm …` or `corepack pnpm …`
 * (install/add/update/remove all share that leader).
 */
export function argvRunsPnpm(argv: string[]): boolean {
  return argv[0] === 'pnpm' || (argv[0] === 'corepack' && argv[1] === 'pnpm');
}

export type BuildApprovalDecision = 'none' | 'approve-all' | 'prompt' | 'guide';

export function planBuildApproval(input: { pendingCount: number; isPnpmInstall: boolean; allowAll: boolean; canPrompt: boolean }): BuildApprovalDecision {
  if (!input.isPnpmInstall || input.pendingCount === 0) return 'none';
  if (input.allowAll) return 'approve-all';
  if (input.canPrompt) return 'prompt';
  return 'guide';
}

export function findPendingBuilds(rootDir: string): string[] {
  const file = path.join(rootDir, WORKSPACE_FILE);
  if (!existsSync(file)) return [];
  try {
    return parsePendingBuilds(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

export interface ApplyResult {
  text: string;
  allowed: string[];
  denied: string[];
}

interface MapSection {
  /** Index of the `allowBuilds:` header line. */
  header: number;
  /** First entry index (inclusive). */
  start: number;
  /** One past the last entry index (exclusive). */
  end: number;
  /** Indent string used for entries in this section (e.g. "  "). */
  itemIndent: string;
}

function locateMapSection(lines: string[], name: string): MapSection | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== `${name}:`) continue;
    const headerIndent = lines[i]!.match(/^\s*/u)![0].length;
    let end = i + 1;
    let itemIndent = `${' '.repeat(headerIndent + 2)}`;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]!;
      if (!raw.trim()) {
        end = j;
        continue;
      }
      const indent = raw.match(/^\s*/u)![0].length;
      if (indent <= headerIndent) break;
      itemIndent = raw.match(/^\s*/u)![0];
      end = j + 1;
    }
    return { header: i, start: i + 1, end, itemIndent };
  }
  return undefined;
}

/** Add `- <name>` entries to a sequence section (e.g. onlyBuiltDependencies), creating it if absent. */
function ensureListEntries(lines: string[], name: string, names: string[]): void {
  const section = locateMapSection(lines, name);
  if (section) {
    const present = new Set<string>();
    for (let i = section.start; i < section.end; i++) {
      const m = lines[i]!.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/u);
      if (m) present.add(m[1]!);
    }
    const additions = names.filter((n) => !present.has(n)).map((n) => `${section.itemIndent}- ${n}`);
    if (additions.length) lines.splice(section.end, 0, ...additions);
    return;
  }
  if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
  lines.push(`${name}:`);
  for (const n of names) lines.push(`  - ${n}`);
}

/** Remove `- <name>` entries from a sequence section, preserving the section itself. */
function removeListEntries(lines: string[], name: string, names: string[]): void {
  const section = locateMapSection(lines, name);
  if (!section || names.length === 0) return;
  const denied = new Set(names);
  for (let i = section.end - 1; i >= section.start; i--) {
    const m = lines[i]!.match(/^\s*-\s+['"]?(.+?)['"]?\s*$/u);
    if (m && denied.has(m[1]!)) lines.splice(i, 1);
  }
}

/**
 * Resolve build-script decisions into pnpm-workspace.yaml: write `allowBuilds: <pkg>: true|false`
 * for every decision and add the approved (true) packages to `onlyBuiltDependencies` so pnpm both
 * builds them and stops re-prompting. One decision, both config locations — so the user never
 * hand-edits YAML. Pure over the file text for testability.
 */
export function applyBuildApprovals(text: string, decisions: Map<string, boolean>): ApplyResult {
  const lines = text.split('\n');
  const allowed = [...decisions].filter(([, v]) => v).map(([k]) => k).sort();
  const denied = [...decisions].filter(([, v]) => !v).map(([k]) => k).sort();

  // 1. allowBuilds: overwrite existing entries, insert any that are missing.
  const remaining = new Set(decisions.keys());
  const section = locateMapSection(lines, 'allowBuilds');
  if (section) {
    for (let i = section.start; i < section.end; i++) {
      const m = lines[i]!.match(/^(\s*)(['"]?)(.+?)\2:\s*(.*)$/u);
      if (m && decisions.has(m[3]!)) {
        lines[i] = `${m[1]}${m[3]}: ${decisions.get(m[3]!)}`;
        remaining.delete(m[3]!);
      }
    }
    const additions = [...remaining].sort().map((n) => `${section.itemIndent}${n}: ${decisions.get(n)}`);
    if (additions.length) lines.splice(section.end, 0, ...additions);
  } else if (decisions.size) {
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
    lines.push('allowBuilds:');
    for (const n of [...decisions.keys()].sort()) lines.push(`  ${n}: ${decisions.get(n)}`);
  }

  // 2. onlyBuiltDependencies: add approvals and remove denials so both pnpm knobs stay in sync.
  if (allowed.length) ensureListEntries(lines, 'onlyBuiltDependencies', allowed);
  if (denied.length) removeListEntries(lines, 'onlyBuiltDependencies', denied);

  return { text: lines.join('\n'), allowed, denied };
}

/** Apply decisions to the on-disk pnpm-workspace.yaml (creating it if needed). */
export function writeBuildApprovals(rootDir: string, decisions: Map<string, boolean>): ApplyResult {
  const file = path.join(rootDir, WORKSPACE_FILE);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const result = applyBuildApprovals(before, decisions);
  writeFileSync(file, result.text.endsWith('\n') ? result.text : `${result.text}\n`);
  return result;
}

/**
 * Interactive approval — all packages selected by default (the common case is "yes, build them").
 * The prompt is honest that these scripts run on the host with no boundary, so the user is making a
 * real trust decision, not rubber-stamping. Returns the decision map, or null if the user cancelled.
 */
export async function promptBuildApprovals(pending: string[]): Promise<Map<string, boolean> | null> {
  const where = 'on your host, with no container boundary';
  const selected = await multiselect<string>({
    message: `${pending.length} package(s) want to run install scripts (${where}). Allow which to build?`,
    options: pending.map((name) => ({ value: name, label: name })),
    initialValues: pending,
    required: false,
  });
  if (isCancel(selected)) return null;
  const approved = new Set(selected as string[]);
  return new Map(pending.map((name) => [name, approved.has(name)]));
}

export function renderApproveBuildsCommand(pending: string[]): string {
  return `screen approve-builds ${pending.join(' ')}`;
}
