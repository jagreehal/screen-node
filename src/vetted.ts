/**
 * Advisory-result cache for frozen installs, keyed by lockfile fingerprint.
 *
 * `npm ci` / `--frozen-lockfile` installs exactly what the lockfile pins, so re-running one resolves
 * the identical set of `name@version` pairs and asks OSV the identical questions. In CI that round-trip
 * runs on every job; locally it runs on every branch switch. Recording the verdict against the
 * lockfile's hash lets an unchanged lockfile skip it.
 *
 * Three things keep this from being a security regression:
 *
 *   1. **The key is the lockfile's content, not its path.** Change one pinned version and the
 *      fingerprint changes, so the check runs again. There is no way to edit a dependency and keep a
 *      stale pass.
 *   2. **The policy is part of the key.** A verdict reached with the age gate off is not a verdict for
 *      a run with it on, so tightening any gate invalidates the entry rather than inheriting a laxer
 *      pass.
 *   3. **Entries expire.** OSV publishes new advisories continuously, so "clean yesterday" is not
 *      "clean now". A day-old entry is discarded and the lookup runs again.
 *
 * Deliberately NOT committed and never read from the repo. A stamp that travelled with the project
 * would let a pull request ship a forged "already vetted" verdict for its own malicious lockfile,
 * which inverts the whole point. It lives in the user cache, so a fresh clone always pays the full
 * check. That makes this a latency optimisation for repeated installs of an unchanged lockfile, which
 * is the honest claim, and not the "vetting travels with the lockfile" property a package manager
 * that owns the lockfile format can offer.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectLockfileName, type PackageManager } from './package-manager.js';

/** How long a clean advisory verdict stays usable. New advisories land continuously. */
export const VETTED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Only a reproducible install can reuse a verdict about the current lockfile. Add/update routes may
 * be invoked while frozen mode is configured, but they propose versions that are not represented by
 * that lockfile yet, so letting them reuse its verdict would skip OSV for the incoming packages.
 */
export function isCacheableFrozenInstall(
  model: string,
  routeFrozen: boolean,
  globalsFrozen: boolean,
  configFrozen: boolean,
): boolean {
  return model === 'install' && (routeFrozen || globalsFrozen || configFrozen);
}

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'screen-node', 'vetted.json');
}

/** The gate settings a verdict was reached under. Any change must invalidate the entry. */
export interface VettedPolicy {
  advisories: boolean;
  deep: boolean;
  minReleaseAgeDays: number;
  /** Known-bad sources are local and version-specific, so a changed blocklist changes the verdict. */
  knownBadCount: number;
}

/**
 * Fingerprint of "this exact lockfile, judged under these exact gates". Returns undefined when there
 * is no lockfile to pin, which correctly disables the cache: without a lockfile a frozen install has
 * nothing stable to key on.
 */
export function lockfileFingerprint(cwd: string, pm: PackageManager, policy: VettedPolicy): string | undefined {
  const file = path.join(cwd, projectLockfileName(cwd, pm));
  if (!existsSync(file)) return undefined;
  try {
    const hash = createHash('sha256');
    hash.update(readFileSync(file));
    // Policy goes in the same digest, so a laxer past run can never satisfy a stricter present one.
    hash.update(`\0${pm}\0${policy.advisories}\0${policy.deep}\0${policy.minReleaseAgeDays}\0${policy.knownBadCount}`);
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

interface VettedStore {
  /** fingerprint -> epoch ms the clean verdict was recorded. */
  [fingerprint: string]: number;
}

function readStore(): VettedStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: VettedStore = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * True when this exact lockfile+policy was found clean recently enough to trust. Any doubt (missing
 * entry, unreadable cache, expired timestamp, clock moved backwards) reads as "not vetted" and the
 * caller runs the real check — the cache can only ever save work, never grant a pass.
 */
export function isVetted(fingerprint: string | undefined, now: Date, ttlMs: number = VETTED_TTL_MS): boolean {
  if (!fingerprint) return false;
  const at = readStore()[fingerprint];
  if (typeof at !== 'number') return false;
  const age = now.getTime() - at;
  return age >= 0 && age < ttlMs;
}

/**
 * Record a CLEAN verdict. Only ever called when every gate ran and found nothing: a blocked install,
 * or one where a gate could not run, must leave no entry behind. Best-effort — a read-only HOME costs
 * the optimisation, never the install.
 */
export function recordVetted(fingerprint: string | undefined, now: Date): void {
  if (!fingerprint) return;
  try {
    const store = readStore();
    // Drop expired entries on write so the file can't grow without bound across branch switches.
    const cutoff = now.getTime() - VETTED_TTL_MS;
    const pruned: VettedStore = { [fingerprint]: now.getTime() };
    for (const [k, v] of Object.entries(store)) {
      if (k !== fingerprint && v > cutoff) pruned[k] = v;
    }
    mkdirSync(path.dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(pruned));
  } catch {
    // best-effort cache
  }
}
