import { createRegistryClient, mapPool, resolveRiskTargets, type RegistryClient, type ResolvedTarget, type RiskTarget } from './risk.js';

/**
 * "Known-bad" axis, complementing the release-age gate's "too-new" axis. Queries the OSV advisory
 * database for the exact version an install would pull and flags it when an advisory matches,
 * with malware advisories (`MAL-…` ids) called out as the high-signal block trigger. OSV publishes
 * npm malware advisories under the `MAL-` id prefix; that's the reliable malware signal.
 */

export const ADVISORY_TIMEOUT_MS = 5000;

export type AdvisorySeverity = 'critical' | 'high' | 'moderate' | 'low';

/** One advisory's metadata, enriched beyond the raw id string. */
export interface AdvisoryDetail {
  id: string;
  /** Short description from the OSV advisory. */
  summary?: string;
  /** CVSS severity level (derived from score). */
  severity?: AdvisorySeverity;
  /** Raw CVSS score (0–10). */
  cvss?: number;
  /** First fixed version from each affected range (empty if not fixed). */
  fixedVersions?: string[];
}

/** Summary counts broken down by severity bucket. */
export interface AdvisorySeverityCounts {
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

/** Result of a single enriched OSV query. */
export interface AdvisoryQueryResult {
  ids: string[];
  details: AdvisoryDetail[];
}

export interface AdvisoryClient {
  /** Return the advisory ids affecting `name@version` (empty when none). */
  query(name: string, version: string): Promise<string[]>;
  /** Richer query: advisory ids + severity, summary, and fix versions from OSV. */
  queryEnriched?(name: string, version: string): Promise<AdvisoryQueryResult>;
}

export interface AdvisoryHit {
  name: string;
  version: string;
  ids: string[];
  /** True when any advisory is a malware report (`MAL-…`). */
  malware: boolean;
  /** Enriched advisory details (populated when the client supports `queryEnriched`). */
  advisories?: AdvisoryDetail[];
  /** Whether this package is a direct dependency (for scan/report grouping). */
  direct?: boolean;
}

/** OSV uses the `MAL-` id prefix for malicious-package advisories. */
export function isMalwareId(id: string): boolean {
  return id.toUpperCase().startsWith('MAL-');
}

/** Map a CVSS numeric score to a severity bucket. */
export function cvssSeverity(score: number): AdvisorySeverity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'moderate';
  return 'low';
}

/** Compute per-severity hit counts from advisory hits (malware counts as critical). */
export function severityCounts(hits: AdvisoryHit[]): AdvisorySeverityCounts {
  const counts: AdvisorySeverityCounts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const hit of hits) {
    if (hit.malware) {
      counts.critical++;
      continue;
    }
    let best: AdvisorySeverity | undefined;
    let bestScore = 0;
    for (const d of hit.advisories ?? []) {
      if (d.cvss !== undefined && d.cvss > bestScore) {
        bestScore = d.cvss;
        best = d.severity;
      }
    }
    if (best) counts[best]++;
    else counts.low++;
  }
  return counts;
}

/** Severity label sort order (critical first). */
const SEVERITY_ORDER: Record<AdvisorySeverity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };

/** Sort advisories by severity (highest first). */
export function sortAdvisoriesBySeverity(details: AdvisoryDetail[]): AdvisoryDetail[] {
  return [...details].sort((a, b) => {
    const sa = a.severity ? (SEVERITY_ORDER[a.severity] ?? 4) : 4;
    const sb = b.severity ? (SEVERITY_ORDER[b.severity] ?? 4) : 4;
    return sa - sb || (b.cvss ?? 0) - (a.cvss ?? 0);
  });
}

/** Extract the highest severity from a list of advisory details. */
export function highestSeverity(details: AdvisoryDetail[]): AdvisorySeverity | undefined {
  let best: AdvisorySeverity | undefined;
  let bestScore = -1;
  for (const d of details) {
    if (d.cvss !== undefined && d.cvss > bestScore) {
      bestScore = d.cvss;
      best = d.severity;
    }
  }
  return best;
}

interface OsvVuln {
  id?: unknown;
  summary?: unknown;
  severity?: unknown[];
  affected?: unknown[];
  database_specific?: Record<string, unknown>;
}

interface OsvAffected {
  ranges?: Array<{
    type?: unknown;
    events?: Array<{ introduced?: unknown; fixed?: unknown }>;
  }>;
}

/** Extract a rough numeric severity from a CVSS v3.x vector string like "CVSS:3.1/AV:N/AC:H/...". */
function parseCvssVectorScore(vector: string): number | undefined {
  if (!vector.startsWith('CVSS:3')) return undefined;
  const parts = vector.split('/');
  let c = 0; let i = 0; let a = 0;
  for (const p of parts) {
    if (p.startsWith('C:')) c = p[2] === 'H' ? 6.0 : p[2] === 'L' ? 2.2 : 0;
    else if (p.startsWith('I:')) i = p[2] === 'H' ? 4.0 : p[2] === 'L' ? 1.5 : 0;
    else if (p.startsWith('A:')) a = p[2] === 'H' ? 2.0 : p[2] === 'L' ? 0.8 : 0;
  }
  if (c === 0 && i === 0 && a === 0) return undefined;
  const impact = c + i + a;
  if (impact >= 12) return 9.8;
  if (impact >= 9) return 8.5;
  if (impact >= 7) return 7.0;
  if (impact >= 5) return 5.5;
  if (impact >= 3) return 4.0;
  return 2.5;
}

/** Map database_specific severity strings to our severity enum. */
function dbSeverity(val: unknown): AdvisorySeverity | undefined {
  if (typeof val !== 'string') return undefined;
  const v = val.toUpperCase();
  if (v === 'CRITICAL') return 'critical';
  if (v === 'HIGH') return 'high';
  if (v === 'MODERATE' || v === 'MEDIUM') return 'moderate';
  if (v === 'LOW') return 'low';
  return undefined;
}

function parseOsvVuln(v: OsvVuln): AdvisoryDetail | undefined {
  const id = typeof v.id === 'string' ? v.id : undefined;
  if (!id) return undefined;

  const summary = typeof v.summary === 'string' ? v.summary : undefined;

  let severity: AdvisorySeverity | undefined;
  let cvss: number | undefined;
  if (Array.isArray(v.severity)) {
    for (const s of v.severity) {
      if (s && typeof s === 'object') {
        const type = (s as Record<string, unknown>).type;
        if (type === 'CVSS_V3' || type === 'CVSS_V2') {
          const score = (s as Record<string, unknown>).score;
          if (typeof score === 'number') {
            cvss = score;
            severity = cvssSeverity(score);
            break;
          }
          if (typeof score === 'string') {
            const n = parseFloat(score);
            if (!Number.isNaN(n)) {
              cvss = n;
              severity = cvssSeverity(n);
              break;
            }
            const vScore = parseCvssVectorScore(score);
            if (vScore !== undefined) {
              cvss = vScore;
              severity = cvssSeverity(vScore);
              break;
            }
          }
        }
      }
    }
  }
  if (!severity && v.database_specific) {
    const dbSev = dbSeverity(v.database_specific.severity);
    if (dbSev) {
      severity = dbSev;
      cvss = dbSev === 'critical' ? 9.5 : dbSev === 'high' ? 7.5 : dbSev === 'moderate' ? 5.5 : 2.5;
    }
  }

  const fixedVersions: string[] = [];
  if (Array.isArray(v.affected)) {
    for (const a of v.affected) {
      if (a && typeof a === 'object' && Array.isArray((a as OsvAffected).ranges)) {
        for (const r of (a as OsvAffected).ranges!) {
          if (r && typeof r === 'object' && Array.isArray(r.events)) {
            let foundFixed = false;
            for (const evt of r.events) {
              if (typeof evt.fixed === 'string' && !foundFixed) {
                fixedVersions.push(evt.fixed);
                foundFixed = true;
              }
            }
          }
        }
      }
    }
  }

  return { id, summary, severity, cvss, fixedVersions: fixedVersions.length ? fixedVersions : undefined };
}

export function createAdvisoryClient(
  fetchImpl: typeof fetch = fetch,
  baseUrl = process.env.SANDBOX_OSV_API ?? 'https://api.osv.dev',
  timeoutMs = ADVISORY_TIMEOUT_MS,
): AdvisoryClient {
  const doQuery = async (name: string, version: string): Promise<AdvisoryQueryResult> => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version, package: { name, ecosystem: 'npm' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`OSV query failed for ${name}@${version}: ${response.status}`);
    const body = (await response.json()) as { vulns?: OsvVuln[] };
    const vulns = body.vulns ?? [];
    const details: AdvisoryDetail[] = [];
    for (const v of vulns) {
      const d = parseOsvVuln(v);
      if (d) details.push(d);
    }
    return { ids: details.map((d) => d.id), details };
  };

  let cache: Promise<AdvisoryQueryResult> | undefined;
  let cacheKey = '';

  return {
    async query(name: string, version: string): Promise<string[]> {
      const key = `${name}@${version}`;
      if (cache && cacheKey === key) {
        const r = await cache;
        return r.ids;
      }
      cacheKey = key;
      cache = doQuery(name, version);
      const r = await cache;
      return r.ids;
    },
    async queryEnriched(name: string, version: string): Promise<AdvisoryQueryResult> {
      const key = `${name}@${version}`;
      if (cache && cacheKey === key) {
        cacheKey = ''; // consumed
        return cache;
      }
      cacheKey = key;
      cache = doQuery(name, version);
      cacheKey = '';
      const r = await cache;
      cache = undefined;
      return r;
    },
  };
}

/**
 * Resolve `targets` to exact versions and query OSV for each. Returns one {@link AdvisoryHit} per
 * package that has at least one advisory. The caller decides whether a malware hit blocks (it does
 * under `--fail-on-advisory` / the strict preset). A query error throws, so the caller can fail open.
 */
export async function checkAdvisories(targets: RiskTarget[], opts: { registryClient?: RegistryClient; advisoryClient?: AdvisoryClient } = {}): Promise<AdvisoryHit[]> {
  const registry = opts.registryClient ?? createRegistryClient();
  const resolved = await resolveRiskTargets(targets, registry);
  return advisoriesForResolved(resolved, opts.advisoryClient ?? createAdvisoryClient());
}

/**
 * Query OSV for already-resolved (name, version) pairs. Split from {@link checkAdvisories} so the
 * preflight can reuse one shared registry resolution rather than resolving again just for advisories.
 */
export async function advisoriesForResolved(resolved: ResolvedTarget[], advisory: AdvisoryClient): Promise<AdvisoryHit[]> {
  const hits: AdvisoryHit[] = [];
  for (const pkg of resolved) {
    const ids = await advisory.query(pkg.name, pkg.version);
    if (ids.length) hits.push({ name: pkg.name, version: pkg.version, ids, malware: ids.some(isMalwareId) });
  }
  return hits;
}

/**
 * Query OSV for a (possibly large) list of (name, version) pairs — the `--deep` transitive tree.
 * De-duplicates by name@version and runs the lookups with bounded concurrency so a big tree doesn't
 * open hundreds of simultaneous OSV requests. Fails open per package: an OSV error for one name drops
 * that package's result rather than the whole scan.
 */
export async function advisoriesForPackages(
  packages: Array<{ name: string; version: string }>,
  advisory: AdvisoryClient,
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
): Promise<AdvisoryHit[]> {
  const seen = new Set<string>();
  const unique = packages.filter((p) => {
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const useEnriched = Boolean(advisory.queryEnriched);
  let done = 0;
  const total = unique.length;
  const hits = await mapPool(unique, concurrency, async (pkg): Promise<AdvisoryHit | undefined> => {
    try {
      if (useEnriched) {
        const r = await advisory.queryEnriched!(pkg.name, pkg.version);
        if (r.ids.length) {
          return { name: pkg.name, version: pkg.version, ids: r.ids, malware: r.ids.some(isMalwareId), advisories: r.details };
        }
      } else {
        const ids = await advisory.query(pkg.name, pkg.version);
        if (ids.length) return { name: pkg.name, version: pkg.version, ids, malware: ids.some(isMalwareId) };
      }
    } catch {
      // fail open per package
    } finally {
      done++;
      onProgress?.(done, total);
    }
    return undefined;
  });
  return hits.filter((h): h is AdvisoryHit => Boolean(h));
}
