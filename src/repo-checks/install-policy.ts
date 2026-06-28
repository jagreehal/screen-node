import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface PnpmWorkspacePolicy {
  allowBuilds: Map<string, boolean>;
  minimumReleaseAge?: number;
  minimumReleaseAgeExclude: string[];
}

export function parsePnpmWorkspacePolicy(text: string): PnpmWorkspacePolicy {
  const allowBuilds = new Map<string, boolean>();
  const minimumReleaseAgeExclude: string[] = [];
  let minimumReleaseAge: number | undefined;
  let section: 'allowBuilds' | 'minimumReleaseAgeExclude' | undefined;
  let sectionIndent = -1;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = rawLine.match(/^\s*/u)?.[0].length ?? 0;
    const trimmed = line.trim();

    const age = trimmed.match(/^minimumReleaseAge:\s*(\d+)\s*$/u);
    if (age) {
      minimumReleaseAge = Number(age[1]);
      section = undefined;
      continue;
    }

    if (indent <= sectionIndent) {
      section = undefined;
      sectionIndent = -1;
    }

    if (trimmed === 'allowBuilds:') {
      section = 'allowBuilds';
      sectionIndent = indent;
      continue;
    }
    if (trimmed === 'minimumReleaseAgeExclude:') {
      section = 'minimumReleaseAgeExclude';
      sectionIndent = indent;
      continue;
    }

    if (section === 'allowBuilds') {
      const match = trimmed.match(/^(['"]?)(.+?)\1:\s*(true|false)\s*$/u);
      if (match) allowBuilds.set(match[2]!, match[3]! === 'true');
      continue;
    }
    if (section === 'minimumReleaseAgeExclude') {
      const match = trimmed.match(/^-\s+['"]?(.+?)['"]?\s*$/u);
      if (match) minimumReleaseAgeExclude.push(match[1]!);
    }
  }

  return { allowBuilds, minimumReleaseAge, minimumReleaseAgeExclude };
}

export function evaluateInstallPolicy(policy: PnpmWorkspacePolicy, opts: { minReleaseAge?: number } = {}): string[] {
  const issues: string[] = [];
  const minReleaseAge = opts.minReleaseAge ?? 4320;
  if ((policy.minimumReleaseAge ?? 0) < minReleaseAge) {
    issues.push(`pnpm minimumReleaseAge must be at least ${minReleaseAge} minutes`);
  }
  const allowedBuilds = [...policy.allowBuilds.entries()].filter(([, allowed]) => allowed).map(([name]) => name);
  if (allowedBuilds.length === 0) {
    issues.push('pnpm allowBuilds must explicitly allow at least one trusted package');
  }
  return issues;
}

export function verifyInstallPolicy(rootDir: string, opts: { minReleaseAge?: number } = {}): string[] {
  const workspaceFile = path.join(rootDir, 'pnpm-workspace.yaml');
  const policy = parsePnpmWorkspacePolicy(readFileSync(workspaceFile, 'utf8'));
  return evaluateInstallPolicy(policy, opts);
}
