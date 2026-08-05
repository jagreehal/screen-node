/**
 * The default-trust floor for build scripts.
 *
 * pnpm refuses unknown dependency install scripts and leaves them undecided; we then prompt. That is
 * the right default, but it fires on every fresh `pnpm install` in every repo, and the packages doing
 * the asking are almost always the same handful of native-build workhorses (esbuild, sharp,
 * better-sqlite3). Prompt fatigue is not a cosmetic problem: a gate that asks a question the user
 * answers "yes" to fifty times in a row is a gate they will eventually route around entirely, and a
 * disabled gate screens nothing. So a narrow, curated floor auto-approves the workhorses -- but only
 * when three independent checks vouch for that exact resolved version.
 *
 * The floor is NOT "this package is popular, so it is safe". Popularity is what an attacker mimics;
 * `data/top-packages.json` is deliberately a typosquat corpus and must never be reused here. It is
 * "this specific name is a known native-build package, AND the version about to run was resolved from
 * the registry, AND no malware advisory matches it, AND it has been public long enough that a
 * publish-and-detonate worm would have been caught". Any one of those failing drops the package back
 * to the prompt. It never widens what runs -- every package here would have been approved by hand
 * anyway; the floor only removes the keystroke.
 *
 * Compromise of a listed package is the residual risk, and it is real: this is the exact path the
 * 2026-06-04-style attacks take. The advisory and cooling gates are what stand in front of it, which
 * is why a package on the list still fails closed when either can't be evaluated.
 */

import { advisoriesForResolved, type AdvisoryClient } from './advisory.js';
import { resolveRiskTargets, type LockfilePackage, type RegistryClient } from './risk.js';

/**
 * Packages whose install script is a legitimate native build or a prebuilt-binary fetch from the
 * project's own distribution channel. Hand-curated and deliberately short: every entry is a package
 * that cannot function without running code at install time, so approving it is the only working
 * answer. Anything that merely *wants* a postinstall (funding banners, telemetry, optional analytics)
 * does not belong here -- the honest answer for those is "deny", not "auto-approve".
 *
 * Kept in source rather than `data/` precisely because it is security-relevant: it should move only
 * through a reviewed diff, never a regenerated artifact.
 */
export const DEFAULT_TRUSTED_BUILDS: readonly string[] = [
  // bundlers / compilers shipping platform binaries
  'esbuild',
  '@swc/core',
  '@tailwindcss/oxide',
  '@biomejs/biome',
  'unrs-resolver',
  'workerd',
  // image / media native builds
  'sharp',
  'canvas',
  're2',
  // database drivers with native bindings
  'better-sqlite3',
  'sqlite3',
  '@prisma/engines',
  'prisma',
  'lmdb',
  'msgpackr-extract',
  // crypto / system bindings
  'bcrypt',
  'cpu-features',
  'ssh2',
  'keytar',
  // filesystem watchers and terminal bindings
  'fsevents',
  '@parcel/watcher',
  'node-pty',
  // browser automation (downloads its own browser build)
  'playwright',
  '@playwright/test',
  'puppeteer',
  // css toolchains with native builds
  'sass-embedded',
  'node-sass',
];

const TRUSTED = new Set(DEFAULT_TRUSTED_BUILDS);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The floor applies its own cooling window even when the install-path release-age gate is off (vibe,
 * trusted, `--min-release-age 0`). Consenting to INSTALL a fresh version is a smaller decision than
 * consenting to EXECUTE it unattended with no human in the loop, so the floor never inherits a zero.
 */
export const MIN_TRUST_AGE_MS = DAY_MS;

/** One pending build script, with everything the three gates need to judge it. */
export interface TrustCandidate {
  name: string;
  /** Resolved version the build would run, or undefined when it couldn't be resolved. */
  version?: string;
  /** Registry publish time for that version; undefined means the cooling gate has nothing to read. */
  publishedAt?: Date;
  /** Resolved from the registry. A git, file, link, tarball, or alias dependency never qualifies. */
  fromRegistry: boolean;
  /**
   * The lockfile named a version for this package. Tracked separately from `fromRegistry` so "we never
   * found out which version would run" doesn't get reported as "this came from somewhere other than
   * the registry" — two very different things to tell a user, and conflating them hid a real bug.
   */
  inLockfile: boolean;
  /** More than one version would be approved by pnpm's package-name-wide decision. */
  multipleVersions?: boolean;
  /** A known-malware advisory matched this exact version. */
  advisoryHit: boolean;
  /**
   * The advisory lookup actually completed. An OSV outage leaves this false, which must NOT read as
   * "vetted" -- the floor fails closed there, unlike the install path, because it is deciding whether
   * to skip a human rather than whether to proceed with one.
   */
  advisoryChecked: boolean;
}

/** Why a candidate did not clear the floor, for the line explaining what still needs a decision. */
export type TrustRejection = 'not-curated' | 'no-lockfile-entry' | 'multiple-versions' | 'not-registry' | 'advisory' | 'unchecked' | 'too-new' | 'unknown-age';

export interface TrustVerdict {
  name: string;
  trusted: boolean;
  /** Set when `trusted` is false: the first gate that refused. */
  reason?: TrustRejection;
}

/**
 * Judge one pending build against the floor. Pure, so the decision is unit-tested directly rather
 * than inferred from an install run. Gates are checked cheapest-first and report the FIRST refusal,
 * which is the one worth showing the user.
 */
export function judgeTrust(candidate: TrustCandidate, opts: { now: Date; minAgeMs?: number }): TrustVerdict {
  const { name } = candidate;
  if (!TRUSTED.has(name)) return { name, trusted: false, reason: 'not-curated' };
  if (!candidate.inLockfile) return { name, trusted: false, reason: 'no-lockfile-entry' };
  // pnpm records approvals by package name, not name+version. If the tree contains two versions, a
  // single approval would execute both, so checking either one alone cannot justify skipping a human.
  if (candidate.multipleVersions) return { name, trusted: false, reason: 'multiple-versions' };
  if (!candidate.fromRegistry || !candidate.version) return { name, trusted: false, reason: 'not-registry' };
  if (candidate.advisoryHit) return { name, trusted: false, reason: 'advisory' };
  if (!candidate.advisoryChecked) return { name, trusted: false, reason: 'unchecked' };
  // Fail closed on unknown publish time: a package we cannot date has not demonstrably survived the
  // worm window, and "no data" is exactly the state a tampered or non-registry source presents.
  if (!candidate.publishedAt) return { name, trusted: false, reason: 'unknown-age' };
  const minAgeMs = Math.max(opts.minAgeMs ?? 0, MIN_TRUST_AGE_MS);
  if (opts.now.getTime() - candidate.publishedAt.getTime() < minAgeMs) return { name, trusted: false, reason: 'too-new' };
  return { name, trusted: true };
}

/** Split pending builds into the auto-approved set and the ones that still need a human. */
export function partitionTrust(candidates: TrustCandidate[], opts: { now: Date; minAgeMs?: number }): { trusted: string[]; remaining: TrustVerdict[] } {
  const verdicts = candidates.map((c) => judgeTrust(c, opts));
  return {
    trusted: verdicts.filter((v) => v.trusted).map((v) => v.name),
    remaining: verdicts.filter((v) => !v.trusted),
  };
}

/**
 * Gather what the floor needs for each pending build: the version the lockfile says will actually run,
 * whether that version resolves from the registry, and whether OSV has anything on it.
 *
 * Only curated names are looked up. That keeps the added latency proportional to the floor's benefit
 * (a repo with twenty pending builds and none curated makes zero requests) and avoids spending a
 * network round-trip to learn something the first gate already decided.
 *
 * Every failure path yields a candidate that CANNOT clear the floor rather than throwing: an outage
 * here means "we could not vouch for this", which is the prompt, not an error.
 */
export async function collectTrustCandidates(
  pending: string[],
  deps: {
    lockfilePackages: () => LockfilePackage[];
    registry: RegistryClient;
    advisory: AdvisoryClient;
  },
): Promise<TrustCandidate[]> {
  const curated = pending.filter((name) => TRUSTED.has(name));
  const bare = (name: string): TrustCandidate => ({ name, fromRegistry: false, inLockfile: false, advisoryHit: false, advisoryChecked: false });
  if (!curated.length) return pending.map(bare);

  // The lockfile is the authority on which version runs — resolving the RANGE would judge a version
  // that isn't the one about to execute.
  let versions = new Map<string, Set<string>>();
  try {
    for (const pkg of deps.lockfilePackages()) {
      const found = versions.get(pkg.name) ?? new Set<string>();
      found.add(pkg.version);
      versions.set(pkg.name, found);
    }
  } catch {
    return pending.map(bare);
  }

  const out = new Map<string, TrustCandidate>(pending.map((name) => [name, bare(name)]));
  for (const name of curated) {
    const installed = versions.get(name);
    if (!installed?.size) continue; // no lockfile entry (a workspace/git dep, or an unparsed lockfile format)
    if (installed.size > 1) {
      out.set(name, { ...bare(name), inLockfile: true, multipleVersions: true });
      continue;
    }
    const [version] = installed;
    if (!version) continue;
    out.set(name, { ...bare(name), inLockfile: true, version });
    try {
      const [resolved] = await resolveRiskTargets([{ name, spec: version }], deps.registry);
      // resolveRiskTargets drops anything whose exact version isn't in the packument, which is
      // precisely the git/file/link/alias case the provenance gate is meant to exclude.
      if (!resolved || resolved.version !== version) continue;
      const hits = await advisoriesForResolved([resolved], deps.advisory);
      out.set(name, {
        name,
        version: resolved.version,
        publishedAt: resolved.publishedAt,
        fromRegistry: true,
        inLockfile: true,
        advisoryHit: hits.some((h) => h.malware),
        advisoryChecked: true,
      });
    } catch {
      // registry or OSV unreachable — leave the bare (untrusted) candidate so this falls to the prompt
    }
  }
  return [...out.values()];
}

/**
 * Why a curated package was still held back, in one line. Only rendered for packages the user would
 * have expected the floor to cover -- `not-curated` is the ordinary case and says nothing useful.
 */
export function explainRejection(reason: TrustRejection): string | undefined {
  switch (reason) {
    case 'not-curated':
      return undefined;
    case 'no-lockfile-entry':
      return 'the lockfile names no version for it, so there was nothing to check';
    case 'multiple-versions':
      return 'the lockfile contains multiple versions, and pnpm approval would execute all of them';
    case 'not-registry':
      return 'not resolved from the registry (git, file, link, or alias dependency)';
    case 'advisory':
      return 'a malware advisory matches this version';
    case 'unchecked':
      return 'the advisory lookup could not run, so nothing vouched for this version';
    case 'too-new':
      return 'published too recently to have cleared the worm window';
    case 'unknown-age':
      return 'no publish time available, so the cooling window could not be evaluated';
  }
}
