import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { stripJsonComments } from './config.js';

/**
 * Known-bad packages from sources the team controls, complementing OSV's "known bad" axis without
 * its publish lag. Two source kinds, one matcher:
 *
 *   1. Advisory files — committed `sandbox.advisories.json` (team policy) and a per-user global one.
 *      A team can block a package the moment they know, before OSV publishes a `MAL-` id.
 *   2. Malware feeds — URLs (e.g. Aikido's public database) fetched by `sandbox feeds update` and
 *      cached locally, so the install-time check stays offline and fast.
 *
 * Anything matched here ALWAYS blocks an install — these are explicit decisions, not gated by
 * `--fail-on-advisory` (which controls the *network* OSV lookup).
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** One blocklist rule: a package name, optionally narrowed to specific versions. */
export interface KnownBadEntry {
  name: string;
  /** Exact versions to block. Omitted or empty = every version of `name`. */
  versions?: string[];
  reason?: string;
  severity?: Severity;
  /** Where the rule came from (file path or feed URL) — shown so a block is traceable. */
  source: string;
}

/** A resolved package that a {@link KnownBadEntry} matched. */
export interface KnownBadHit {
  name: string;
  version: string;
  reason: string;
  severity: Severity;
  source: string;
}

/** The committed, team-shared advisory file (drop it in the repo root — no config needed). */
export const PROJECT_ADVISORY_NAME = 'sandbox.advisories.json';

export function projectAdvisoryPath(cwd: string): string {
  return path.join(cwd, PROJECT_ADVISORY_NAME);
}

/** Per-user global advisories: `$XDG_CONFIG_HOME/sandbox-node/advisories.json` (machine-wide). */
export function userAdvisoryPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'sandbox-node', 'advisories.json');
}

/** Where `sandbox feeds update` caches fetched feeds: `$XDG_CACHE_HOME/sandbox-node/feeds/`. */
export function feedCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
  return path.join(base, 'sandbox-node', 'feeds');
}

function asSeverity(v: unknown): Severity | undefined {
  return v === 'critical' || v === 'high' || v === 'medium' || v === 'low' ? v : undefined;
}

/**
 * Parse an advisory file body. Accepts either a top-level array of entries or `{ "advisories": [...] }`.
 * Each entry needs a `name`; `versions`/`reason`/`severity` are optional. Tolerant of JSONC comments
 * so the file can document itself. Throws on malformed JSON (a typo'd blocklist should fail loudly,
 * not silently stop blocking).
 */
export function parseAdvisoryFile(text: string, source: string): KnownBadEntry[] {
  const parsed = JSON.parse(stripJsonComments(text)) as unknown;
  const raw = Array.isArray(parsed) ? parsed : (parsed as { advisories?: unknown })?.advisories;
  if (!Array.isArray(raw)) throw new Error(`${source}: expected an array of advisories or { "advisories": [...] }`);
  const out: KnownBadEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) throw new Error(`${source}: every advisory needs a non-empty "name"`);
    const versions = Array.isArray(rec.versions) ? rec.versions.filter((v): v is string => typeof v === 'string') : undefined;
    // `["*"]` means "every version" — same as omitting `versions`.
    const allVersions = !versions || !versions.length || versions.includes('*');
    out.push({
      name,
      versions: allVersions ? undefined : versions,
      reason: typeof rec.reason === 'string' ? rec.reason : undefined,
      severity: asSeverity(rec.severity),
      source,
    });
  }
  return out;
}

/** Read one advisory file. Missing file → no entries. */
export function loadAdvisoryFile(file: string): KnownBadEntry[] {
  if (!existsSync(file)) return [];
  return parseAdvisoryFile(readFileSync(file, 'utf8'), file);
}

/** One package from a feed: a name, optional exact version, optional reason. */
export interface FeedPackage {
  name: string;
  version?: string;
  reason?: string;
}

/** Cached feed payload written by {@link updateFeeds}. */
interface FeedCacheFile {
  feed: string;
  fetchedAt: string;
  packages: FeedPackage[];
}

/** Load every cached feed in `dir` as known-bad entries (severity assumed critical — feeds list malware). */
export function loadFeedCache(dir = feedCacheDir()): KnownBadEntry[] {
  if (!existsSync(dir)) return [];
  const out: KnownBadEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let data: FeedCacheFile;
    try {
      data = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as FeedCacheFile;
    } catch {
      continue; // a corrupt cache file shouldn't wedge the matcher
    }
    for (const p of data.packages ?? []) {
      if (!p?.name) continue;
      const reason = p.reason ? `${p.reason} (malware feed)` : `listed in malware feed ${data.feed}`;
      out.push({ name: p.name, versions: p.version && p.version !== '*' ? [p.version] : undefined, reason, severity: 'critical', source: data.feed });
    }
  }
  return out;
}

/** All known-bad entries for `cwd`: project advisories + user advisories + cached feeds. */
export function loadKnownBad(cwd: string, opts: { cacheDir?: string } = {}): KnownBadEntry[] {
  return [...loadAdvisoryFile(projectAdvisoryPath(cwd)), ...loadAdvisoryFile(userAdvisoryPath()), ...loadFeedCache(opts.cacheDir)];
}

/**
 * Match resolved packages against the blocklist. A name-only entry blocks every version; an entry
 * with `versions` blocks only those exact versions. First matching entry per package wins. Pure.
 */
export function matchKnownBad(packages: Array<{ name: string; version: string }>, entries: KnownBadEntry[]): KnownBadHit[] {
  const byName = new Map<string, KnownBadEntry[]>();
  for (const e of entries) {
    const list = byName.get(e.name) ?? [];
    list.push(e);
    byName.set(e.name, list);
  }
  const hits: KnownBadHit[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    const candidates = byName.get(pkg.name);
    if (!candidates) continue;
    const match = candidates.find((e) => !e.versions || e.versions.includes(pkg.version));
    if (!match) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ name: pkg.name, version: pkg.version, reason: match.reason ?? 'listed as known-bad', severity: match.severity ?? 'critical', source: match.source });
  }
  return hits;
}

/**
 * Parse a fetched feed body into {@link FeedPackage}s. Accepts the common shapes malware feeds publish:
 * a JSON array of names; a JSON array of objects keyed by `name` OR `package_name` (Aikido's actual
 * field) with optional `version`/`reason`; a `{ packages: [...] }` / `{ malware: [...] }` wrapper; or a
 * CSV/newline list (`name` or `name,version` per row; a header row is skipped). A `*` version = all.
 */
export function parseFeed(text: string): FeedPackage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed) as unknown;
    const arr = Array.isArray(json) ? json : ((json as Record<string, unknown>).packages ?? (json as Record<string, unknown>).malware);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((item): FeedPackage | undefined => {
        if (typeof item === 'string') return item.trim() ? { name: item.trim() } : undefined;
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          // Aikido publishes `package_name`; generic feeds use `name`. Accept either.
          const rawName = typeof rec.name === 'string' ? rec.name : typeof rec.package_name === 'string' ? rec.package_name : '';
          const name = rawName.trim();
          if (!name) return undefined;
          const version = typeof rec.version === 'string' && rec.version ? rec.version : undefined;
          return { name, version, reason: typeof rec.reason === 'string' && rec.reason ? rec.reason : undefined };
        }
        return undefined;
      })
      .filter((x): x is FeedPackage => Boolean(x));
  }
  // CSV / newline-delimited.
  const out: FeedPackage[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    const [name, version] = row.split(',').map((c) => c.trim());
    if (!name || /^(name|package|package_name)$/i.test(name)) continue; // skip header
    out.push({ name, version: version || undefined });
  }
  return out;
}

/** Result of fetching one feed during `sandbox feeds update`. */
export interface FeedUpdate {
  feed: string;
  count: number;
  error?: string;
}

function feedFileName(url: string): string {
  return `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.json`;
}

/**
 * Fetch each feed URL, parse it, and write a cache file per feed. Prunes cache files for feeds no
 * longer in the list so a removed feed stops matching. Per-feed failures are reported (not thrown) so
 * one dead URL doesn't abort the rest. Returns one {@link FeedUpdate} per feed.
 */
export async function updateFeeds(feeds: string[], opts: { fetchImpl?: typeof fetch; cacheDir?: string; now?: Date; timeoutMs?: number } = {}): Promise<FeedUpdate[]> {
  const dir = opts.cacheDir ?? feedCacheDir();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  mkdirSync(dir, { recursive: true });

  const wanted = new Set(feeds.map(feedFileName));
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.json') && !wanted.has(file)) rmSync(path.join(dir, file), { force: true });
  }

  const results: FeedUpdate[] = [];
  for (const feed of feeds) {
    try {
      const res = await fetchImpl(feed, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const packages = parseFeed(await res.text());
      const payload: FeedCacheFile = { feed, fetchedAt: now.toISOString(), packages };
      writeFileSync(path.join(dir, feedFileName(feed)), `${JSON.stringify(payload, null, 2)}\n`);
      results.push({ feed, count: packages.length });
    } catch (e) {
      results.push({ feed, count: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
