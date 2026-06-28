import type { PreflightPolicy, PreflightResult } from './preflight.js';
import type { RiskHint } from './risk.js';

/**
 * The active supply-chain gate configuration for one run: the effective flags after merging CLI
 * globals over config defaults, plus the {@link PreflightPolicy} the registry resolve runs under.
 * Built by `resolvePolicy` (in cli.ts, which owns the Globals type), then consumed by the pure gate
 * deciders here. Kept beside those deciders, not in cli.ts, so the block decision is testable without
 * importing the self-executing CLI entrypoint.
 */
export interface ActivePolicy {
  riskHints: boolean;
  minReleaseAgeDays: number;
  failOnAdvisory: boolean;
  failOnDeprecated: boolean;
  failOnRisk: boolean;
  deep: boolean;
  policy: PreflightPolicy;
}

/** The deprecated-version hints in a preflight result (split out: both the gate and its log use it). */
export function deprecatedHints(result: PreflightResult): RiskHint[] {
  return result.hints.filter((h) => h.code === 'deprecated');
}

/** True when no gate is active and there's nothing to resolve: the install path can skip the round-trip. */
export function nothingToCheck(ap: ActivePolicy): boolean {
  return !ap.riskHints && !ap.policy.advisories && ap.minReleaseAgeDays === 0;
}

/**
 * The blocking decision: does this preflight result fail the install, and with what exit code? Pure and
 * exhaustive over the block reasons in severity order. Known-bad (team blocklist / malware feed),
 * release-age violations, and OSV malware ALWAYS block (no opt-out: there is no safe version). Deprecated
 * versions block only when `failOnDeprecated`; any risk hint blocks only under `--fail-on-risk`. Returns
 * undefined when nothing blocks. This is the one function that decides whether a bad dependency lands, so
 * it lives here with direct unit coverage rather than buried in the CLI.
 */
export function blockExit(result: PreflightResult, ap: ActivePolicy): number | undefined {
  if (result.knownBadHits.length) return 1;
  if (result.ageViolations.length) return 1;
  if (result.advisoryHits.some((h) => h.malware)) return 1;
  if (ap.failOnDeprecated && deprecatedHints(result).length) return 1;
  if (ap.riskHints && result.hints.length && ap.failOnRisk) return 1;
  return undefined;
}
