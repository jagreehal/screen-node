import { isExcluded, splitNameAndSpec, type RiskHint } from './risk.js';
import type { PackageManager } from './package-manager.js';

/**
 * The pure brain of "safe install by default": freshness holdback for an `add`. When a package being
 * added resolves to a version inside the freshness/worm window, install the newest release that already
 * predates the window instead, pinned exact. Pure and writes nothing: HOW the swap is surfaced
 * (receipt, confirm) lives at the call site, so the decision is testable without a container, a TTY, or
 * a registry, the same pattern the rest of the CLI follows.
 *
 * Scope is deliberately freshness ONLY. Malware, typosquats, and CVE advisories are NOT handled here:
 * the gate engine already blocks/reports them upstream before an install fetches anything, so there is
 * no safe-version choice for this module to make. Auto-substituting a CVE fix or refusing a typosquat
 * from here would change install semantics (a product decision, with copy, docs, and false-positive
 * review), not just internals. If that broader policy is ever wanted, add it as a named follow-up with
 * explicit product intent rather than carrying a dormant engine here.
 */

/** One concrete change safe-install will apply to an `add`: install `to` (pinned exact) instead of `from`. */
export interface Substitution {
  name: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * Translate preflight risk hints into the freshness substitutions safe-install should apply for an
 * `add`. Only packages explicitly being added are eligible (we never silently re-pin a transitive or
 * an existing dep), and `--allow-recent` patterns opt a package back into taking the fresh version.
 * Pure: the registry/aged-version work already happened in preflight and rides on the hint's detail.
 */
export function freshSubstitutions(hints: RiskHint[], addedNames: string[], opts: { allowRecent?: string[] } = {}): Substitution[] {
  const added = new Set(addedNames);
  const allow = opts.allowRecent ?? [];
  const out: Substitution[] = [];
  for (const h of hints) {
    if (h.code !== 'recent_version' || !h.detail.aged) continue;
    if (!added.has(h.package)) continue;
    if (isExcluded(h.package, allow)) continue; // --allow-recent: take the fresh version as typed
    const from = h.version ?? 'latest';
    const to = h.detail.aged.version;
    // Frame the swap as age, never as a safety guarantee: pin-debt is real, so name exactly what changed.
    const reason = `${from} is inside the worm window, installed ${to} which predates it (older, more battle-tested, not certified safe)`;
    out.push({ name: h.package, from, to, reason });
  }
  return out;
}

/** The flag each package manager needs so `add` writes an EXACT version to the manifest, not a `^range`. */
const EXACT_FLAG: Record<PackageManager, string> = { npm: '--save-exact', pnpm: '--save-exact', yarn: '--exact', bun: '--exact' };

/**
 * The real package name an `add` token resolves to, the SAME resolution preflight uses to key its
 * findings (so a substitution keyed by that name can find its token). Handles aliases: `foo@npm:bar@1`
 * → `bar`. Returns undefined for flags and non-registry specs (file:/git/workspace/url), which we never
 * substitute. Delegating to splitNameAndSpec keeps token matching and risk evaluation in lock-step.
 */
function tokenRealName(token: string): string | undefined {
  if (token.startsWith('-')) return undefined;
  return splitNameAndSpec(token)?.name;
}

/** A name@version spec with its version part stripped, alias-preserving: `foo@npm:bar@1` → `foo@npm:bar`. */
function specWithoutVersion(token: string): string {
  const npm = token.indexOf('@npm:');
  if (npm !== -1) return `${token.slice(0, npm)}@npm:${bareName(token.slice(npm + '@npm:'.length))}`;
  return bareName(token);
}

/** The package name (no version) of a plain or scoped spec: `bar@1` → `bar`, `@s/p@1` → `@s/p`. */
function bareName(spec: string): string {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', spec.indexOf('/') + 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at <= 0 ? spec : spec.slice(0, at);
}

/**
 * Rewrite the `add` package list to apply the substitutions: the substituted package's token keeps its
 * original form (alias and all) with only the version swapped to `to`, and the exact-pin flag is
 * appended so the manifest records the precise version (the package manager otherwise writes a
 * `^range`). Matching is by the token's REAL package name, so an aliased spec (`foo@npm:bar@1`) is
 * rewritten correctly rather than skipped. A substitution always forces exact (we chose the version, so
 * it must be reproducible); `pinExact` additionally forces exact for the untouched ones. Note: the PM's
 * exact flag is command-global, so when ANY package is substituted, every package named in the same
 * `add` is written exact — called out in the receipt.
 */
export function rewriteAddArgs(pkgs: string[], subs: Substitution[], pm: PackageManager, pinExact: boolean): string[] {
  const byName = new Map(subs.map((s) => [s.name, s]));
  const rewritten = pkgs.map((tok) => {
    const real = tokenRealName(tok);
    const sub = real ? byName.get(real) : undefined;
    return sub ? `${specWithoutVersion(tok)}@${sub.to}` : tok;
  });
  const flag = EXACT_FLAG[pm];
  if ((subs.length > 0 || pinExact) && !rewritten.includes(flag) && !rewritten.includes('-E')) rewritten.push(flag);
  return rewritten;
}

/**
 * The package names in an `add` that aren't being substituted but will STILL land exact, because the
 * package manager's exact flag applies to the whole command, not one package. Surfaced in the receipt
 * so co-installed packages getting pinned isn't a silent surprise. (Empty when `pinExact` is already on
 * — then exact-for-all was the user's explicit choice, so there's nothing to flag.)
 */
export function incidentallyPinned(pkgs: string[], subs: Substitution[]): string[] {
  const subNames = new Set(subs.map((s) => s.name));
  return pkgs.map(tokenRealName).filter((name): name is string => name !== undefined && !subNames.has(name));
}

/** The "here's what I installed and why" receipt: names the swap, that it's pinned, and the override. */
export function formatSafeReceipt(subs: Substitution[], alsoPinnedExact: string[] = []): string {
  const lines = subs.map((s) => `  installed ${s.name}@${s.to} (pinned exact), not ${s.from}. ${s.reason}`);
  const names = subs.map((s) => s.name).join(' ');
  const tail: string[] = [];
  if (alsoPinnedExact.length) {
    tail.push(`  ${alsoPinnedExact.join(', ')} ${alsoPinnedExact.length === 1 ? 'is' : 'are'} pinned exact too because the exact flag applies to the whole add`);
  }
  tail.push(`  take the newest version instead: add --allow-recent ${names} before the command`);
  return ['safe install changed this add:', ...lines, ...tail].join('\n');
}
