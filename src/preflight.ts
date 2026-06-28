import { advisoriesForPackages, advisoriesForResolved, createAdvisoryClient, type AdvisoryClient, type AdvisoryHit } from './advisory.js';
import { matchKnownBad, type KnownBadEntry, type KnownBadHit } from './known-bad.js';
import {
  createRegistryClient,
  expiredDomainHints,
  hintsFromResolved,
  isExcluded,
  lowDownloadHints,
  readAllPackagesFromLockfile,
  releaseAgeViolations,
  resolveRiskTargets,
  scanDeepTree,
  suggestAgedVersion,
  type DownloadsClient,
  type LockfilePackage,
  type NsResolver,
  type RegistryClient,
  type ReleaseAgeViolation,
  type ResolvedTarget,
  type RiskHint,
  type RiskTarget,
} from './risk.js';
import type { PackageManager } from './package-manager.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the preflight should check for one route. The three gates used to each resolve the registry
 * independently; this collects their parameters so the preflight resolves the direct targets ONCE
 * and feeds the same resolved set to all of them.
 */
export interface PreflightPolicy {
  /** Compute advisory/risk hints (the advisory warnings shown before install). */
  riskHints: boolean;
  /** `thorough`: also run the noisier/network-backed signals (missing metadata, low downloads,
   * expired maintainer domains) on top of the fast packument-only `basic` set. */
  thorough: boolean;
  /** Release-age gate threshold in days; 0 = gate off. */
  minReleaseAgeDays: number;
  /** Package-name patterns exempt from the age gate. */
  releaseAgeExclude: string[];
  /** Gate the whole resolved tree (lockfile) rather than just the direct targets. */
  deep: boolean;
  /** Run the OSV malware lookup (and let the caller block on a malware hit). */
  advisories: boolean;
}

/** Everything the preflight found, for the caller to log and turn into an exit code. */
export interface PreflightResult {
  hints: RiskHint[];
  ageViolations: ReleaseAgeViolation[];
  advisoryHits: AdvisoryHit[];
  /** Packages matched by the local blocklist / malware feeds — ALWAYS block (explicit team decision). */
  knownBadHits: KnownBadHit[];
  /** Number of direct targets actually resolved (for the "checked N packages" line). */
  checkedCount: number;
  /** Number of resolved packages the deep gate examined, when `deep` ran. */
  deepCount?: number;
}

export interface PreflightContext {
  pm: PackageManager;
  cwd: string;
  registryClient?: RegistryClient;
  advisoryClient?: AdvisoryClient;
  now?: Date;
  /** Override lockfile reading (tests); defaults to reading `cwd`'s lockfile. */
  readLockfile?: (cwd: string, pm: PackageManager) => LockfilePackage[];
  /** Override the DNS NS resolver used by the expired-domain signal (tests). */
  nsResolver?: NsResolver;
  /** Override the downloads client used by the low-downloads signal (tests). */
  downloadsClient?: DownloadsClient;
  /** Local blocklist + cached malware-feed entries to match against (always-block, OSV-independent). */
  knownBad?: KnownBadEntry[];
}

function nothingToDo(policy: PreflightPolicy): boolean {
  return !policy.riskHints && !policy.advisories && policy.minReleaseAgeDays === 0;
}

/**
 * The `thorough`-only signals that need a request beyond the packument: expired maintainer domains
 * (DNS) and low download counts (npm downloads API). Both fail open internally, so a combined
 * failure here just yields fewer hints; the outer try/catch is the final backstop.
 */
async function networkSignals(resolved: ResolvedTarget[], ctx: PreflightContext): Promise<RiskHint[]> {
  const [domains, downloads] = await Promise.all([
    expiredDomainHints(resolved, { resolver: ctx.nsResolver }),
    lowDownloadHints(resolved, { client: ctx.downloadsClient }),
  ]);
  return [...domains, ...downloads];
}

/**
 * Resolve `targets` against the registry once, then run every active gate over that single result:
 * risk hints, the release-age gate, and the OSV advisory check. Each is independently toggled by
 * `policy`. Resolution and per-gate lookups fail OPEN (the caller proceeds inside containment) so a
 * registry/OSV outage can't wedge installs. The deep age gate reads the full lockfile tree and so
 * does its own resolution; the other two always share the direct-target resolution.
 *
 * Pure of logging and exit codes by design: the returned {@link PreflightResult} is the test
 * surface, and the CLI shell decides what to print and what blocks.
 */
export async function runPreflight(targets: RiskTarget[], policy: PreflightPolicy, ctx: PreflightContext): Promise<PreflightResult> {
  const result: PreflightResult = { hints: [], ageViolations: [], advisoryHits: [], knownBadHits: [], checkedCount: 0 };
  const knownBad = ctx.knownBad ?? [];
  const wantKnownBad = knownBad.length > 0;
  if (nothingToDo(policy) && !wantKnownBad) return result;

  const now = ctx.now ?? new Date();
  const registry = ctx.registryClient ?? createRegistryClient();
  const wantAge = policy.minReleaseAgeDays > 0;

  // Read the lockfile tree up front when ANY deep-able gate is requested — release age, deprecation,
  // or malware. An empty tree (no lockfile, or bun, which has no parser) falls the gates back to the
  // direct targets so `--deep` never silently disables them.
  const wantDeep = policy.deep && (wantAge || policy.riskHints || policy.advisories || wantKnownBad);
  let deepPackages: LockfilePackage[] | undefined;
  if (wantDeep) {
    try {
      deepPackages = (ctx.readLockfile ?? readAllPackagesFromLockfile)(ctx.cwd, ctx.pm);
      result.deepCount = deepPackages.length;
    } catch {
      deepPackages = [];
      result.deepCount = 0;
    }
  }
  const useDeep = wantDeep && (deepPackages?.length ?? 0) > 0;
  const directAgeGate = wantAge && !useDeep; // direct when not deep, or when deep found no tree
  // Known-bad matches the deep tree when available, else the direct targets — so resolve direct when
  // there's no deep tree to cover it (a version-specific blocklist entry needs the resolved version).
  const needDirectResolve = policy.riskHints || policy.advisories || directAgeGate || (wantKnownBad && !useDeep);

  if (needDirectResolve && targets.length) {
    try {
      const resolved = await resolveRiskTargets(targets, registry);
      result.checkedCount = resolved.length;
      // Direct hints: when deep covers the tree, drop deprecated here (deep reports it for the whole
      // tree, including these direct deps) — the other hint codes stay direct-only by design.
      if (policy.riskHints) {
        let hints = hintsFromResolved(resolved, now);
        if (useDeep) hints = hints.filter((h) => h.code !== 'deprecated');
        // `missing_metadata` is the noisy packument signal — only at `thorough`, never `basic`.
        if (!policy.thorough) hints = hints.filter((h) => h.code !== 'missing_metadata');
        result.hints = hints;
        if (policy.thorough) result.hints = [...result.hints, ...(await networkSignals(resolved, ctx))];
      }
      if (directAgeGate) {
        const gated = resolved.filter((pkg) => !isExcluded(pkg.name, policy.releaseAgeExclude));
        result.ageViolations = releaseAgeViolations(gated, policy.minReleaseAgeDays * DAY_MS, now);
      }
      // Direct advisory only when deep won't cover the tree (deep advisory is a superset).
      if (policy.advisories && !useDeep) {
        result.advisoryHits = await advisoriesForResolved(resolved, ctx.advisoryClient ?? createAdvisoryClient());
      }
      // Known-bad over the direct targets when deep won't cover the tree.
      if (wantKnownBad && !useDeep) result.knownBadHits = matchKnownBad(resolved, knownBad);
    } catch {
      // fail open — a resolution error leaves the (empty) findings and the caller proceeds.
    }
  }

  if (useDeep) {
    // One packument per name → release age + deprecations across the whole tree. Skip the packument
    // pass entirely when neither axis is wanted (e.g. deep + advisory-only).
    if (wantAge || policy.riskHints) {
      try {
        const scan = await scanDeepTree(deepPackages!, {
          client: registry,
          now,
          exclude: policy.releaseAgeExclude,
          minReleaseAgeDays: wantAge ? policy.minReleaseAgeDays : 0,
          deprecations: policy.riskHints,
        });
        if (wantAge) result.ageViolations = scan.ageViolations;
        if (policy.riskHints) result.hints = [...result.hints, ...scan.deprecated];
      } catch {
        // fail open
      }
    }
    // Malware/advisory across the tree (separate OSV lookups, bounded concurrency).
    if (policy.advisories) {
      try {
        result.advisoryHits = await advisoriesForPackages(deepPackages!, ctx.advisoryClient ?? createAdvisoryClient());
      } catch {
        // fail open
      }
    }
    // Known-bad over the whole tree (offline, no lookups) — a superset of the direct match.
    if (wantKnownBad) result.knownBadHits = matchKnownBad(deepPackages!, knownBad);
  }

  return result;
}

/** A blocked package paired with the older version the user can pin instead. */
export interface PinSuggestion {
  name: string;
  version: string;
  ageMs: number;
}

/**
 * For each release-age violation, the newest already-aged version to pin instead. One registry
 * fetch per distinct blocked name (violations are the rare path, so serial is fine), de-duplicated
 * by name. A name with no aged-in version simply yields no suggestion. Fails open per package.
 */
export async function suggestPins(violations: ReleaseAgeViolation[], minReleaseAgeDays: number, ctx: { client?: RegistryClient; now?: Date } = {}): Promise<PinSuggestion[]> {
  const client = ctx.client ?? createRegistryClient();
  const minAgeMs = minReleaseAgeDays * DAY_MS;
  const out: PinSuggestion[] = [];
  for (const name of new Set(violations.map((v) => v.name))) {
    const aged = await suggestAgedVersion(name, minAgeMs, { client, now: ctx.now });
    if (aged) out.push({ name, version: aged.version, ageMs: aged.ageMs });
  }
  return out;
}
