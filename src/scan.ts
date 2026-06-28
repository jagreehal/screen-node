import { advisoriesForPackages, createAdvisoryClient, type AdvisoryClient, type AdvisoryHit, type AdvisorySeverityCounts, severityCounts as computeSeverityCounts } from './advisory.js';
import { matchKnownBad, type KnownBadEntry, type KnownBadHit } from './known-bad.js';
import { readAllPackagesFromLockfile, type LockfilePackage } from './risk.js';
import type { PackageManager } from './package-manager.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readDirectDependencyNames } from './project.js';

/**
 * Retroactive supply-chain scan. The install-time gates only know what's flagged *at install*; the
 * dominant way a compromise surfaces is later — OSV publishes a `MAL-` advisory for a version you
 * already have. `runScan` re-queries OSV for the currently-resolved lockfile tree so a dependency
 * that turned malicious *after* it was installed is caught on the next scan (CI, cron, or on demand).
 *
 * Pure of logging/exit codes by design (mirrors {@link runPreflight}): the {@link ScanResult} is the
 * test surface; the CLI shell decides what to print and what blocks. Per-package OSV lookups fail
 * OPEN (a query error drops that package, never the whole scan).
 */

/** One ignored advisory: a package + optional advisory-id + reason from the triage file. */
export interface AuditIgnoreEntry {
  name: string;
  /** If set, only this specific advisory id is ignored. If absent, all advisories for the package. */
  advisoryId?: string;
  reason?: string;
}

export interface ScanResult {
  /** Distinct `name@version` pairs examined from the lockfile. */
  scanned: number;
  /** Every advisory hit (malware and non-malware). */
  hits: AdvisoryHit[];
  /** The subset flagged as malware (`MAL-…`) — the high-signal block trigger. */
  malware: AdvisoryHit[];
  /** Installed packages matched by the local blocklist / malware feeds — also block. */
  knownBadHits: KnownBadHit[];
  /** No parseable lockfile (none committed, or bun, which has no parser yet). */
  lockfileMissing: boolean;
  /** Advisory hits filtered through the triage file (user-suppressed). */
  triaged: AdvisoryHit[];
  /** Severity breakdown of non-triaged advisory hits. */
  severityCounts: AdvisorySeverityCounts;
}

export interface ScanContext {
  pm: PackageManager;
  cwd: string;
  advisoryClient?: AdvisoryClient;
  /** Local blocklist + cached malware-feed entries to match the lockfile against. */
  knownBad?: KnownBadEntry[];
  /** Override lockfile reading (tests); defaults to reading `cwd`'s lockfile. */
  readLockfile?: (cwd: string, pm: PackageManager) => LockfilePackage[];
  /** Called after each OSV query completes with (done, total). */
  onProgress?: (done: number, total: number) => void;
  /** Direct dependency names (for direct/transitive tagging). Auto-detected if omitted. */
  directNames?: Set<string>;
  /** Triage entries from `.screen-audit-ignore` (auto-read if omitted). */
  auditIgnore?: AuditIgnoreEntry[];
}

const AUDIT_IGNORE_FILE = '.screen-audit-ignore';

/** Parse `.screen-audit-ignore`: `<package> [<advisory-id>] [-- <reason>]`, one per line. */
export function readAuditIgnore(cwd: string): AuditIgnoreEntry[] {
  const file = path.join(cwd, AUDIT_IGNORE_FILE);
  if (!existsSync(file)) return [];
  const entries: AuditIgnoreEntry[] = [];
  try {
    const text = readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const reasonIdx = line.indexOf(' -- ');
      let rest = reasonIdx >= 0 ? line.slice(0, reasonIdx).trim() : line;
      const reason = reasonIdx >= 0 ? line.slice(reasonIdx + 4).trim() : undefined;
      const parts = rest.split(/\s+/);
      const name = parts[0]!;
      const advisoryId = parts[1];
      entries.push({ name, ...(advisoryId ? { advisoryId } : {}), ...(reason ? { reason } : {}) });
    }
  } catch {
    return [];
  }
  return entries;
}

/** Check whether a hit is covered by the triage list. */
export function isTriaged(hit: AdvisoryHit, ignore: AuditIgnoreEntry[]): boolean {
  for (const entry of ignore) {
    if (entry.name !== hit.name) continue;
    if (!entry.advisoryId) return true; // blanket ignore for this package
    if (hit.ids.includes(entry.advisoryId)) return true;
  }
  return false;
}

export async function runScan(ctx: ScanContext): Promise<ScanResult> {
  let packages: LockfilePackage[];
  try {
    packages = (ctx.readLockfile ?? readAllPackagesFromLockfile)(ctx.cwd, ctx.pm);
  } catch {
    packages = [];
  }
  if (packages.length === 0) {
    return { scanned: 0, hits: [], malware: [], knownBadHits: [], lockfileMissing: true, triaged: [], severityCounts: { critical: 0, high: 0, moderate: 0, low: 0 } };
  }
  const scanned = new Set(packages.map((p) => `${p.name}@${p.version}`)).size;

  const directNames = ctx.directNames ?? new Set(readDirectDependencyNames(ctx.cwd));

  const hits = await advisoriesForPackages(packages, ctx.advisoryClient ?? createAdvisoryClient(), 8, ctx.onProgress);

  // Tag direct vs transitive
  for (const hit of hits) hit.direct = directNames.has(hit.name);

  const knownBadHits = matchKnownBad(packages, ctx.knownBad ?? []);

  // Triage: separate ignored from active
  const ignore = ctx.auditIgnore ?? readAuditIgnore(ctx.cwd);
  const triaged: AdvisoryHit[] = [];
  const active: AdvisoryHit[] = [];
  for (const hit of hits) {
    (isTriaged(hit, ignore) ? triaged : active).push(hit);
  }

  return { scanned, hits: active, malware: active.filter((h) => h.malware), knownBadHits, lockfileMissing: false, triaged, severityCounts: computeSeverityCounts(active) };
}
