import { advisoriesForPackages, createAdvisoryClient, type AdvisoryClient, type AdvisoryHit } from './advisory.js';
import { matchKnownBad, type KnownBadEntry, type KnownBadHit } from './known-bad.js';
import {
  createRegistryClient,
  readAllPackagesFromLockfile,
  scanDeepTree,
  type LockfilePackage,
  type RegistryClient,
  type ReleaseAgeViolation,
  type RiskHint,
} from './risk.js';
import type { PackageManager } from './package-manager.js';

/**
 * Lockfile-delta gate. A full `--deep` preflight re-checks the entire resolved tree on every run; in
 * a PR that's noisy and slow when only a handful of packages actually changed. `runDelta` diffs the
 * head lockfile against a base (the merge target) and runs the blocking gates over ONLY the
 * added/bumped `name@version` pairs — so a PR is judged on exactly what it introduces: fresh
 * publishes (release-age), known malware (OSV), and newly-pulled deprecated versions.
 *
 * Pure of logging/exit codes (mirrors {@link runPreflight}). Every lookup fails OPEN.
 */

/** Head packages whose exact `name@version` is absent from base — new packages AND version bumps. */
export function changedPackages(base: LockfilePackage[], head: LockfilePackage[]): LockfilePackage[] {
  const baseKeys = new Set(base.map((p) => `${p.name}@${p.version}`));
  const seen = new Set<string>();
  const out: LockfilePackage[] = [];
  for (const p of head) {
    const key = `${p.name}@${p.version}`;
    if (baseKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export interface DeltaPolicy {
  /** Release-age gate threshold in days; 0 = off. */
  minReleaseAgeDays: number;
  /** Package-name patterns exempt from the age gate. */
  releaseAgeExclude: string[];
  /** Run the OSV malware lookup over the changed set. */
  advisories: boolean;
}

export interface DeltaResult {
  /** The added/bumped packages the gates examined. */
  changed: LockfilePackage[];
  ageViolations: ReleaseAgeViolation[];
  advisoryHits: AdvisoryHit[];
  deprecated: RiskHint[];
  /** Changed packages matched by the local blocklist / malware feeds — always block. */
  knownBadHits: KnownBadHit[];
  /** Base lockfile couldn't be read — every head package is treated as changed (fail safe, gate all). */
  baseMissing: boolean;
}

export interface DeltaContext {
  pm: PackageManager;
  cwd: string;
  /** Base (merge-target) tree, already parsed by the CLI shell from git or a file. */
  base: LockfilePackage[];
  baseMissing?: boolean;
  registryClient?: RegistryClient;
  advisoryClient?: AdvisoryClient;
  /** Local blocklist + cached malware-feed entries to match the changed set against. */
  knownBad?: KnownBadEntry[];
  now?: Date;
  /** Override head lockfile reading (tests); defaults to reading `cwd`'s lockfile. */
  readLockfile?: (cwd: string, pm: PackageManager) => LockfilePackage[];
}

export async function runDelta(policy: DeltaPolicy, ctx: DeltaContext): Promise<DeltaResult> {
  let head: LockfilePackage[];
  try {
    head = (ctx.readLockfile ?? readAllPackagesFromLockfile)(ctx.cwd, ctx.pm);
  } catch {
    head = [];
  }
  const changed = changedPackages(ctx.base, head);
  const result: DeltaResult = {
    changed,
    ageViolations: [],
    advisoryHits: [],
    deprecated: [],
    knownBadHits: matchKnownBad(changed, ctx.knownBad ?? []),
    baseMissing: ctx.baseMissing ?? false,
  };
  if (changed.length === 0) return result;

  const now = ctx.now ?? new Date();
  const registry = ctx.registryClient ?? createRegistryClient();

  // Release age + deprecation over the changed subset (one packument per name).
  if (policy.minReleaseAgeDays > 0) {
    try {
      const scan = await scanDeepTree(changed, {
        client: registry,
        now,
        exclude: policy.releaseAgeExclude,
        minReleaseAgeDays: policy.minReleaseAgeDays,
        deprecations: true,
      });
      result.ageViolations = scan.ageViolations;
      result.deprecated = scan.deprecated;
    } catch {
      // fail open
    }
  }

  // Known-malware advisory over the changed subset.
  if (policy.advisories) {
    try {
      result.advisoryHits = await advisoriesForPackages(changed, ctx.advisoryClient ?? createAdvisoryClient());
    } catch {
      // fail open
    }
  }

  return result;
}
