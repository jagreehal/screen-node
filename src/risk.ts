import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Resolver } from 'node:dns/promises';
import type { LogLevel } from './log.js';
import { lockfileName, type PackageManager } from './package-manager.js';
import type { ProjectFacts } from './project.js';

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare'] as const;
const RECENT_VERSION_STRONG_MS = 24 * 60 * 60 * 1000;
const RECENT_VERSION_LIGHT_MS = 7 * 24 * 60 * 60 * 1000;
const NEW_PACKAGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Typosquat edit-distance ceiling: up to 2 edits from a popular name is suspicious; 0 is the package itself. */
const TYPOSQUAT_MAX_DISTANCE = 2;
/**
 * Shortest name the typosquat signal will judge. Below this, a 1–2 edit band catches half the
 * registry: `ai`, `vm`, `js`, `mcp` all land within two edits of dozens of unrelated short names
 * (`c8`, `rc`, `ws`, `arg`), so the matches are noise, not impersonation. Real typosquat targets
 * (`lodash`, `express`, `chalk`, `react`) are all longer than this.
 */
const TYPOSQUAT_MIN_NAME_LENGTH = 5;
/** A first-ever publish by this user this recent reads like an account takeover, not a long-stable package. */
const NEW_PUBLISHER_RECENT_MS = 21 * 24 * 60 * 60 * 1000;
/** Maintainer reappears after a long silence: >6mo warns, >9mo errors (dormant-account compromise). */
const DORMANT_WARN_MS = 183 * 24 * 60 * 60 * 1000;
const DORMANT_ERROR_MS = 274 * 24 * 60 * 60 * 1000;
/** Monthly downloads at or under this read as "almost nobody uses this" — pair with a fresh publish. */
const LOW_DOWNLOADS_THRESHOLD = 50;

export type RiskLevel = 'warn' | 'error';

interface RiskHintBase {
  level: RiskLevel;
  package: string;
  version?: string;
  message: string;
}

/**
 * Discriminated on `code`: each variant carries exactly the `detail` shape its code
 * implies, so readers narrow on `hint.code` and reach into `detail` with no casts.
 */
export type RiskHint =
  | (RiskHintBase & { code: 'install_script'; detail: { script: string } })
  | (RiskHintBase & { code: 'recent_version'; detail: RecentVersionDetail })
  | (RiskHintBase & { code: 'new_package'; detail: { createdAt: string } })
  | (RiskHintBase & { code: 'bin_exposed'; detail: { bin: string } })
  | (RiskHintBase & { code: 'deprecated'; detail: { deprecated: string } })
  | (RiskHintBase & { code: 'typosquat'; detail: { similarTo: string[] } })
  | (RiskHintBase & { code: 'provenance_regression'; detail: { priorVersion: string } })
  | (RiskHintBase & { code: 'maintainer_change'; detail: MaintainerChangeDetail })
  | (RiskHintBase & { code: 'missing_metadata'; detail: { missing: string[] } })
  | (RiskHintBase & { code: 'low_downloads'; detail: { downloads: number } })
  | (RiskHintBase & { code: 'expired_domain'; detail: { domain: string } });

interface MaintainerChangeDetail {
  kind: 'new_publisher' | 'dormant';
  publisher: string;
  /** Days the publisher was dormant before this release (`dormant` only). */
  gapDays?: number;
  /** Days since the publisher's first-ever publish of this package (`new_publisher` only). */
  firstPublishAgeDays?: number;
}

export type RiskCode = RiskHint['code'];

export interface RiskTarget {
  name: string;
  spec: string;
}

/** One line the CLI should emit at the given log level — the rendered risk-hint report. */
export interface RiskLogLine {
  level: LogLevel;
  text: string;
}

function formatRiskPackage(hint: RiskHint): string {
  return `${hint.package}${hint.version ? `@${hint.version}` : ''}`;
}

function riskDetailLine(hint: RiskHint, pm: PackageManager | undefined): string {
  if (hint.code === 'bin_exposed') return `adds bin: ${hint.detail.bin}`;
  if (hint.code === 'recent_version') {
    const head = hint.detail.severity === 'strong' ? `!! ${hint.message}` : hint.message;
    const aged = hint.detail.aged;
    if (!aged) return head;
    // Offer the newest release that already predates the worm window. Framed as age, never "safe":
    // an older version is more battle-tested, not certified clean. Read-only suggestion, no auto-swap.
    const pin = pm ? `: screen ${pm} add ${hint.package}@${aged.version}` : '';
    return `${head}\n    ↳ ${aged.version} predates the worm window (published ${humanAge(aged.ageMs)})${pin}`;
  }
  // High-signal codes (typosquat, provenance regression, maintainer takeover, expired domain) are
  // error-level — flag them with the same `!!` emphasis as a very-fresh version.
  return hint.level === 'error' ? `!! ${hint.message}` : hint.message;
}

/**
 * Decide what the risk-hint report should print, and at what level — pure, so the "invisible when
 * clean" behaviour is testable without a logger. `contained` is the call site: the install path
 * (true) is about to run inside the box, so a clean check stays out of the way at `debug`; an
 * explicit `check` (false) confirms it looked, since that's the whole reason it was run.
 */
export function planRiskHintLog(targetCount: number, allHints: RiskHint[], { contained, pm }: { contained: boolean; pm?: PackageManager }): RiskLogLine[] {
  const out: RiskLogLine[] = [];
  const hints = allHints.filter((h) => h.code !== 'deprecated'); // deprecated has its own gate/message
  const checked = targetCount ? `checked ${targetCount} package${targetCount === 1 ? '' : 's'} for registry risk hints` : undefined;
  // A bin is the boundary doing its job (a CLI installs its CLI), not a finding to weigh. It never
  // counts toward the headline, and a package whose ONLY signal is a bin stays silent (debug below).
  // So "N things worth a look" reflects real signals, not routine tooling. (--json still carries every
  // hint, bins included.)
  const headlineCount = hints.filter((h) => h.code !== 'bin_exposed').length;
  if (!headlineCount) {
    if (checked) out.push({ level: contained ? 'debug' : 'info', text: checked });
    return out;
  }
  if (checked) out.push({ level: 'info', text: checked });
  out.push({ level: 'warn', text: `${headlineCount} thing${headlineCount === 1 ? '' : 's'} worth a look before installing` });
  const grouped = new Map<string, RiskHint[]>();
  for (const hint of hints) {
    const key = formatRiskPackage(hint);
    grouped.set(key, [...(grouped.get(key) ?? []), hint]);
  }
  // Lead with the worst. Error-level packages (typosquat, provenance drop, malware-window publish)
  // sort above warn-only ones, the same worst-first contract logAdvisoryHits already honours, so the
  // ✖ block can't land buried mid-list. A package whose only signal is a bin has no real finding, so
  // it sinks to debug (silent in the normal report). Array.sort is stable, so same-band packages keep
  // generation order (typosquat → provenance → maintainer → …).
  const rank = (level: LogLevel) => (level === 'error' ? 0 : level === 'warn' ? 1 : 2);
  const ordered = [...grouped.entries()]
    .map(([pkg, pkgHints]) => {
      const real = pkgHints.some((hint) => hint.code !== 'bin_exposed');
      const level: LogLevel = !real ? 'debug' : pkgHints.some((hint) => hint.level === 'error') ? 'error' : 'warn';
      return { pkg, pkgHints, level };
    })
    .sort((a, b) => rank(a.level) - rank(b.level));
  for (const { pkg, pkgHints, level } of ordered) {
    out.push({ level, text: [pkg, ...pkgHints.map((hint) => `  ${riskDetailLine(hint, pm)}`)].join('\n') });
  }
  // One plain "why this is fine" line, instead of repeating "still contained" on every hint above.
  out.push({
    level: 'info',
    text: contained
      ? 'heads-up only, the gates passed and this install is about to continue. A native install runs lifecycle scripts on the host, so the gates are heuristic screening, not a hard boundary.'
      : "heads-up only, this was a check, so nothing was installed or downloaded. Run the install when you're ready.",
  });
  return out;
}

export interface RegistryClient {
  getPackument(name: string): Promise<Packument>;
}

interface NpmUser {
  name?: string;
  email?: string;
}

interface VersionManifest {
  scripts?: Partial<Record<(typeof INSTALL_SCRIPTS)[number], string>>;
  bin?: string | Record<string, string>;
  deprecated?: string;
  /** Per-version publisher recorded by the registry — drives the maintainer-change signals. */
  _npmUser?: NpmUser;
  /** `dist.attestations` presence is the cheap provenance signal (no crypto, packument-only). */
  dist?: { attestations?: unknown };
  repository?: string | { url?: string; type?: string };
  license?: string | { type?: string };
}

interface Packument {
  name: string;
  versions: Record<string, VersionManifest>;
  time?: Record<string, string>;
  'dist-tags'?: Record<string, string>;
  /** Top-level maintainer accounts — the email domains the expired-domain signal resolves. */
  maintainers?: NpmUser[];
}

interface RecentVersionDetail {
  publishedAt: string;
  severity: 'strong' | 'light';
  /** Newest stable release that already predates the worm window — the honest "an older, more
   * battle-tested version exists" suggestion. Age, not safety. Omitted when nothing older qualifies. */
  aged?: { version: string; ageMs: number };
}

export interface ResolvedTarget {
  name: string;
  spec: string;
  version: string;
  manifest: VersionManifest;
  createdAt?: Date;
  publishedAt?: Date;
  /** The full packument, so the cross-version signals (provenance regression, maintainer change,
   * expired domain) can reason over every release without a second fetch. */
  packument: Packument;
}

interface NpmLockDependency {
  version?: string;
}

interface NpmLockfile {
  packages?: Record<string, { version?: string }>;
  dependencies?: Record<string, NpmLockDependency>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Cap on a single registry lookup. Risk hints are advisory, so a slow or rate-limited
 * registry must never hang the install: past this, the lookup aborts, the caller catches
 * it, and the install proceeds inside containment with no hints (see `evaluateRiskTargets`).
 */
export const REGISTRY_TIMEOUT_MS = 5000;

export function createRegistryClient(fetchImpl: typeof fetch = fetch, baseUrl = process.env.SANDBOX_NPM_REGISTRY ?? 'https://registry.npmjs.org', timeoutMs = REGISTRY_TIMEOUT_MS): RegistryClient {
  return {
    async getPackument(name: string): Promise<Packument> {
      const encoded = encodeURIComponent(name).replace(/^%40/, '@');
      // Full packument (NOT the abbreviated `vnd.npm.install-v1+json`): the abbreviated
      // format omits the `time` map, which the release-age gate and the recent-version hint
      // both depend on. Larger responses, but bounded by the timeout and only for direct deps.
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${encoded}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`registry lookup failed for ${name}: ${response.status}`);
      const body = (await response.json()) as unknown;
      if (!isRecord(body) || !isRecord(body.versions)) throw new Error(`registry response for ${name} was malformed`);
      return body as unknown as Packument;
    },
  };
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function isUnsupportedSpec(spec: string): boolean {
  return spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('workspace:') || /^(?:git\+|https?:)/.test(spec);
}

function splitScopedName(raw: string): { name: string; spec: string } | undefined {
  if (!raw.startsWith('@')) return undefined;
  const slash = raw.indexOf('/');
  if (slash === -1) return undefined;
  const secondAt = raw.indexOf('@', slash + 1);
  const parsed = secondAt === -1 ? { name: raw, spec: '' } : { name: raw.slice(0, secondAt), spec: raw.slice(secondAt + 1) };
  return isUnsupportedSpec(parsed.spec) ? undefined : parsed;
}

export function splitNameAndSpec(raw: string): { name: string; spec: string } | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('file:') || raw.startsWith('link:') || raw.startsWith('workspace:')) return undefined;
  if (/^(?:git\+|https?:)/.test(raw)) return undefined;
  if (raw.includes('@npm:')) {
    const aliasSplit = raw.split('@npm:');
    const target = splitNameAndSpec(aliasSplit.slice(1).join('@npm:'));
    return target;
  }
  const scoped = splitScopedName(raw);
  if (scoped) return isPackageName(scoped.name) ? scoped : undefined;
  const at = raw.indexOf('@');
  const parsed = at === -1 ? { name: raw, spec: '' } : { name: raw.slice(0, at), spec: raw.slice(at + 1) };
  if (isUnsupportedSpec(parsed.spec)) return undefined;
  return isPackageName(parsed.name) ? parsed : undefined;
}

const VALUE_FLAGS = new Set([
  '--tag',
  '--workspace',
  '--filter',
  '--prefix',
  '--registry',
  '--cache',
  '--userconfig',
  '--otp',
  '--loglevel',
  '--save-prefix',
]);

export function parsePackageTargets(tokens: string[]): RiskTarget[] {
  const out: RiskTarget[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token) continue;
    if (VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;
    const parsed = splitNameAndSpec(token);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * The versions an UPDATE would pull — the supply-chain surface to gate. Unlike install (which
 * resolves to the locked, already-vetted versions), update is checked against each dep's RANGE so
 * the registry resolves the *newest in-range* version — exactly what the update will install — and
 * the age/OSV/deprecation gates run on that incoming version. `--latest`/`-L` bumps past the range,
 * so those resolve against the dist-tag latest instead. `names` restricts to a named subset; empty
 * means all direct deps. Non-registry specs (workspace:/file:/git/url) are dropped by `splitNameAndSpec`.
 */
export function riskTargetsForUpdate(facts: ProjectFacts, names: string[], latest: boolean): RiskTarget[] {
  const only = new Set(names.map((n) => splitNameAndSpec(n)?.name).filter((n): n is string => Boolean(n)));
  return facts.directDependencies
    .filter((dep) => only.size === 0 || only.has(dep.name))
    .flatMap((dep) => {
      // Validate against the REAL spec first so workspace:/file:/git/url deps are dropped — `--latest`
      // blanks the spec, which would otherwise resurrect a workspace package as a bare registry name.
      const target = splitNameAndSpec(`${dep.name}@${dep.spec}`);
      if (!target) return [];
      return [latest ? { name: target.name, spec: '' } : target];
    });
}

export function riskTargetsForInstall(facts: ProjectFacts): RiskTarget[] {
  const exactVersions = readDirectVersionsFromLockfile(facts.cwd, facts.pm);
  return facts.directDependencies
    .map((dep) => {
      const exact = resolveExactDirectVersion(dep.name, dep.spec, facts.pm, exactVersions);
      // No bare-name fallback: a `workspace:`/`file:`/git/url spec resolves to undefined and is
      // dropped, never resurrected as a bare registry name (which would 404 and fail the whole gate).
      return splitNameAndSpec(exact ? `${dep.name}@${exact}` : `${dep.name}@${dep.spec}`);
    })
    .filter((dep): dep is RiskTarget => Boolean(dep));
}

/** `-p/--package` names a package to fetch; the first positional is otherwise the package. */
const EXEC_PACKAGE_FLAGS = new Set(['-p', '--package']);
/** exec-runner flags that consume the following token (so it isn't mistaken for the package). */
const EXEC_VALUE_FLAGS = new Set(['-c', '--call', '--registry', '--cache', '--userconfig', '--loglevel', '--shell', '--shell-mode']);

/**
 * The package(s) a *run*-model command would fetch and execute on the fly:
 * `npx <pkg>`, `bunx <pkg>`, `bun x <pkg>`, `pnpm dlx <pkg>`, `yarn dlx <pkg>`, `npm exec <pkg>`.
 * Returns `[]` for anything that runs *your own* code (`node x.js`, `vite`, an npm
 * script) so only the fetch-and-run supply-chain surface is risk-checked. The first
 * positional is the package; later positionals are its arguments. `-p/--package` wins.
 */
export function execPackageTargets(argv: string[]): RiskTarget[] {
  const [leader, second] = argv;
  let rest: string[] | undefined;
  if (leader === 'npx' || leader === 'bunx' || leader === 'pnpx') rest = argv.slice(1);
  else if (leader === 'npm' && second === 'exec') rest = argv.slice(2);
  else if ((leader === 'pnpm' || leader === 'yarn') && second === 'dlx') rest = argv.slice(2);
  else if (leader === 'bun' && second === 'x') rest = argv.slice(2);
  if (!rest) return [];

  const explicit: RiskTarget[] = [];
  let firstPositional: RiskTarget | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (token === '--' || !token) continue;
    if (EXEC_PACKAGE_FLAGS.has(token)) {
      const value = rest[++i];
      const parsed = value ? splitNameAndSpec(value) : undefined;
      if (parsed) explicit.push(parsed);
      continue;
    }
    if (EXEC_VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!firstPositional) firstPositional = splitNameAndSpec(token); // later positionals are the package's args
  }
  if (explicit.length) return explicit;
  return firstPositional ? [firstPositional] : [];
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: (number | string)[];
}

function parseSemver(value: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  };
}

function compareIdentifier(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a.localeCompare(b);
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const cmp = compareIdentifier(left, right);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function parseLooseVersion(value: string): { major?: number; minor?: number; patch?: number; wildcard: boolean } | undefined {
  if (value === '*' || /^x$/i.test(value)) return { wildcard: true };
  const parts = value.replace(/^v/, '').split('.');
  if (parts.length > 3) return undefined;
  const parsed: Array<number | undefined> = [];
  let wildcard = false;
  for (const part of parts) {
    if (part === '*' || /^x$/i.test(part)) {
      wildcard = true;
      parsed.push(undefined);
      continue;
    }
    if (!/^\d+$/.test(part)) return undefined;
    parsed.push(Number(part));
  }
  return { major: parsed[0], minor: parsed[1], patch: parsed[2], wildcard };
}

function cmpVersion(version: Semver, op: '<' | '<=' | '>' | '>=' | '=', target: Semver): boolean {
  const cmp = compareSemver(version, target);
  switch (op) {
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '=':
      return cmp === 0;
  }
}

function nextMajor(version: { major: number }): Semver {
  return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
}

function nextMinor(version: { major: number; minor: number }): Semver {
  return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
}

function nextPatch(version: { major: number; minor: number; patch: number }): Semver {
  return { major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: [] };
}

function matchesSimple(version: Semver, token: string): boolean {
  const loose = parseLooseVersion(token);
  if (!loose) return false;
  if (loose.wildcard && loose.major === undefined) return true;
  if (loose.major === undefined) return true;
  const lower: Semver = { major: loose.major, minor: loose.minor ?? 0, patch: loose.patch ?? 0, prerelease: [] };
  if (loose.wildcard || loose.minor === undefined) return cmpVersion(version, '>=', lower) && cmpVersion(version, '<', nextMajor(lower));
  if (loose.patch === undefined) return cmpVersion(version, '>=', lower) && cmpVersion(version, '<', nextMinor(lower));
  return cmpVersion(version, '=', lower);
}

function matchesCaret(version: Semver, raw: string): boolean {
  const loose = parseLooseVersion(raw);
  if (!loose || loose.major === undefined) return true;
  const lower: Semver = { major: loose.major, minor: loose.minor ?? 0, patch: loose.patch ?? 0, prerelease: [] };
  let upper: Semver;
  if (lower.major > 0) upper = nextMajor(lower);
  else if (lower.minor > 0) upper = nextMinor(lower);
  else upper = nextPatch(lower);
  return cmpVersion(version, '>=', lower) && cmpVersion(version, '<', upper);
}

function matchesTilde(version: Semver, raw: string): boolean {
  const loose = parseLooseVersion(raw);
  if (!loose || loose.major === undefined) return true;
  const lower: Semver = { major: loose.major, minor: loose.minor ?? 0, patch: loose.patch ?? 0, prerelease: [] };
  const upper = loose.minor === undefined ? nextMajor(lower) : nextMinor(lower);
  return cmpVersion(version, '>=', lower) && cmpVersion(version, '<', upper);
}

function matchesComparator(version: Semver, token: string): boolean {
  if (token.startsWith('^')) return matchesCaret(version, token.slice(1));
  if (token.startsWith('~')) return matchesTilde(version, token.slice(1));
  const match = /^(<=|>=|<|>|=)?(.+)$/.exec(token);
  if (!match) return false;
  const operator = (match[1] ?? '=') as '<' | '<=' | '>' | '>=' | '=';
  const raw = match[2]!.trim();
  if (!raw) return true;
  if (!/[x*]/i.test(raw) && /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(raw)) {
    const exact = parseSemver(raw.includes('.') && raw.split('.').length === 3 ? raw : `${raw}${raw.split('.').length === 1 ? '.0.0' : '.0'}`);
    return exact ? cmpVersion(version, operator, exact) : false;
  }
  return operator === '=' ? matchesSimple(version, raw) : false;
}

function satisfies(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const trimmed = range.trim();
  if (!trimmed || trimmed === 'latest') return true;
  const alternatives = trimmed.split('||').map((part) => part.trim()).filter(Boolean);
  return alternatives.some((part) => part.split(/\s+/).every((token) => matchesComparator(parsed, token)));
}

function isPrereleaseVersion(version: string): boolean {
  const parsed = parseSemver(version);
  return parsed ? parsed.prerelease.length > 0 : false;
}

function resolveVersion(spec: string, packument: Packument): string | undefined {
  const versions = Object.keys(packument.versions);
  if (versions.length === 0) return undefined;
  const distTags = packument['dist-tags'] ?? {};
  const trimmed = spec.trim();
  // Prereleases (RC/beta/next) count only when the spec explicitly asks for one — otherwise a caret
  // range like ^1.1.3 resolves to the latest STABLE match, never a newer RC (npm/pnpm semantics).
  // Without this a range over-matches the newest prerelease and the gate flags a version no install
  // would ever pick.
  const stable = (list: string[]): string[] => (trimmed.includes('-') ? list : list.filter((v) => !isPrereleaseVersion(v)));
  if (!trimmed) return distTags.latest ?? stable(versions).sort(compareVersionStrings).at(-1);
  if (distTags[trimmed]) return distTags[trimmed];
  if (packument.versions[trimmed]) return trimmed;
  const matches = stable(versions).filter((version) => satisfies(version, trimmed)).sort(compareVersionStrings);
  return matches.at(-1);
}

function compareVersionStrings(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return a.localeCompare(b);
  return compareSemver(left, right);
}

function humanAge(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / (60 * 1000)));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function binDetail(bin: VersionManifest['bin']): string | undefined {
  if (typeof bin === 'string') return `${bin}`;
  if (!bin || !Object.keys(bin).length) return undefined;
  const [name, target] = Object.entries(bin)[0]!;
  return `${name} -> ${target}`;
}

/**
 * Levenshtein edit distance (Wagner–Fischer, single-row), with early-exit once the running minimum
 * exceeds `maxDistance` — the only caller asks "is this within 2 edits of a popular name?", so it
 * never needs the exact distance beyond the band.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  if (b.length - a.length > maxDistance) return b.length - a.length;

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  const curr = Array.from<number>({ length: a.length + 1 }).fill(0);
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    let rowMin = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i]! + 1, curr[i - 1]! + 1, prev[i - 1]! + cost);
      if (curr[i]! < rowMin) rowMin = curr[i]!;
    }
    if (rowMin > maxDistance) return rowMin;
    prev = [...curr];
  }
  return prev[a.length]!;
}

/**
 * Top-package corpus for the typosquat signal, loaded lazily from the bundled `data/top-packages.json`
 * (generated by `scripts/gen-top-packages.mjs`). Resolves relative to this module so it works both
 * from `src` under vitest and from `dist` when published. Cached as a Set after first read; a missing
 * or malformed file disables the signal (returns an empty set) rather than throwing — fail open.
 */
let topPackagesCache: Set<string> | undefined;
export function loadTopPackages(): Set<string> {
  if (topPackagesCache) return topPackagesCache;
  try {
    const file = new URL('../data/top-packages.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    topPackagesCache = new Set(Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []);
  } catch {
    topPackagesCache = new Set();
  }
  return topPackagesCache;
}

/**
 * The scopes that own at least one package in the top-packages corpus, e.g. `@typescript-eslint`,
 * `@ai-sdk`, `@total-typescript`. npm scopes are owned namespaces: a member of a reputable scope
 * can't be a typosquat of an unrelated unscoped name, so we never edit-distance-match those. Derived
 * once from {@link loadTopPackages} and cached alongside it.
 */
let topScopesCache: Set<string> | undefined;
export function loadTopScopes(): Set<string> {
  if (topScopesCache) return topScopesCache;
  const scopes = new Set<string>();
  for (const name of loadTopPackages()) {
    if (name.startsWith('@') && name.includes('/')) scopes.add(name.slice(0, name.indexOf('/')));
  }
  topScopesCache = scopes;
  return topScopesCache;
}

/** Test seam: replace the corpus (also resets it to the bundled file when called with undefined). */
export function setTopPackagesForTest(names: string[] | undefined): void {
  topPackagesCache = names ? new Set(names) : undefined;
  topScopesCache = undefined; // recomputed from the new corpus on next read
}

/**
 * Popular package names within the typosquat edit-distance band of `name`. Empty when `name` is
 * itself popular (it IS the real package), sits in a reputable scope, is too short to judge, or
 * nothing is close. Scoped names from an UNKNOWN scope compare on the part after the slash so
 * `@evil/loadsh` still trips against `lodash`; names from a known scope (`@typescript-eslint/parser`)
 * are trusted by namespace ownership and skipped.
 */
function typosquatMatches(name: string, corpus: Set<string>): string[] {
  if (corpus.size === 0 || corpus.has(name)) return [];
  // A reputable, owned scope can't be impersonated by edit distance on its unscoped part.
  if (name.startsWith('@') && name.includes('/') && loadTopScopes().has(name.slice(0, name.indexOf('/')))) return [];
  const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  if (corpus.has(bare)) return [];
  // Below the length floor the edit-distance band is meaningless (every short name matches many).
  if (bare.length < TYPOSQUAT_MIN_NAME_LENGTH) return [];
  const matches: string[] = [];
  for (const popular of corpus) {
    if (popular.length < TYPOSQUAT_MIN_NAME_LENGTH) continue; // don't match against short popular names either
    const d = levenshtein(bare, popular, TYPOSQUAT_MAX_DISTANCE);
    // Distance 1 (a single sub/insert/delete) for any pair; distance 2 only between SAME-LENGTH names
    // (the classic substitution/transposition squat like `loadsh`→`lodash`). A distance-2 match across
    // different lengths is usually a legit compound name, not impersonation: `tsconfig`→`config`,
    // `ts-reset`→`ts-jest`.
    if (d === 1 || (d === 2 && bare.length === popular.length)) matches.push(popular);
  }
  return matches;
}

/** Newest version older than `installed` whose packument entry carries `dist.attestations`. */
function priorVersionWithProvenance(packument: Packument, installed: string): string | undefined {
  const target = parseSemver(installed);
  if (!target) return undefined;
  const older = Object.keys(packument.versions)
    .map((v) => ({ v, parsed: parseSemver(v) }))
    .filter((c): c is { v: string; parsed: Semver } => Boolean(c.parsed) && compareSemver(c.parsed!, target) < 0)
    .sort((a, b) => compareSemver(b.parsed, a.parsed)); // newest-older first
  for (const { v } of older) {
    if (packument.versions[v]?.dist?.attestations) return v;
  }
  return undefined;
}

/** Latest publish time (ms) for `email` on this package strictly before `currentMs`, else null. */
function lastPriorPublishMsForEmail(packument: Packument, email: string, currentMs: number): number | null {
  let best: number | null = null;
  for (const [version, manifest] of Object.entries(packument.versions)) {
    if (manifest._npmUser?.email !== email) continue;
    const t = parseDate(packument.time?.[version]);
    if (!t) continue;
    const ms = t.getTime();
    if (ms >= currentMs) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

/**
 * Account-takeover signals from the publisher history, computed from the packument alone:
 *  - **new_publisher**: the installed version is the publisher's first-ever release of this package
 *    AND it landed within the last 21 days (a brand-new account on an established package). An old
 *    first-publish is just the original author, so it's not flagged.
 *  - **dormant**: the same publisher reappears after a long silence (>6mo warns, >9mo errors) — the
 *    pattern when a long-idle maintainer account is compromised and used to push one release.
 * Returns the single highest-signal hint (or none).
 */
function maintainerChangeHint(pkg: ResolvedTarget, now: Date): RiskHint | undefined {
  const manifest = pkg.packument.versions[pkg.version];
  const email = manifest?._npmUser?.email;
  const publisher = manifest?._npmUser?.name ?? email;
  const publishedMs = pkg.publishedAt?.getTime();
  if (!email || !publisher || publishedMs === undefined) return undefined;

  // First-ever publish by this email on this package?
  let firstMsForEmail: number | null = null;
  for (const [version, m] of Object.entries(pkg.packument.versions)) {
    if (m._npmUser?.email !== email) continue;
    const t = parseDate(pkg.packument.time?.[version]);
    if (t && (firstMsForEmail === null || t.getTime() < firstMsForEmail)) firstMsForEmail = t.getTime();
  }
  if (firstMsForEmail !== null && firstMsForEmail === publishedMs) {
    const age = now.getTime() - publishedMs;
    if (age >= 0 && age < NEW_PUBLISHER_RECENT_MS) {
      return {
        level: 'error',
        code: 'maintainer_change',
        package: pkg.name,
        version: pkg.version,
        message: `first release ever by publisher ${publisher} (${humanAge(age)}); possible account takeover`,
        detail: { kind: 'new_publisher', publisher, firstPublishAgeDays: Math.floor(age / DAY_MS) },
      };
    }
  }

  // Dormant maintainer: prior publish by the same email, then a long gap.
  const prior = lastPriorPublishMsForEmail(pkg.packument, email, publishedMs);
  if (prior !== null) {
    const gap = publishedMs - prior;
    if (gap > DORMANT_WARN_MS) {
      return {
        level: gap > DORMANT_ERROR_MS ? 'error' : 'warn',
        code: 'maintainer_change',
        package: pkg.name,
        version: pkg.version,
        message: `publisher ${publisher} was dormant ${Math.floor(gap / DAY_MS)} days before this release`,
        detail: { kind: 'dormant', publisher, gapDays: Math.floor(gap / DAY_MS) },
      };
    }
  }
  return undefined;
}

/** The metadata-quality fields a healthy package almost always has; their absence is a weak signal. */
function missingMetadata(manifest: VersionManifest): string[] {
  const missing: string[] = [];
  const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (!repo) missing.push('repository');
  const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
  if (!license) missing.push('license');
  return missing;
}

// ── Network-backed signals (the `thorough` risk level) ───────────────────────────────────────────
// These cost extra requests beyond the packument, so they only run at `riskHints: "thorough"`. Both
// fail OPEN: a DNS or downloads outage yields no hint, never a block and never a hang.

export interface NsResolver {
  resolveNs(domain: string): Promise<string[]>;
}

/**
 * NS resolver with a hard per-lookup timeout (so a slow resolver can't stall preflight). Defaults
 * to the host's configured DNS servers, it respects split-horizon / corporate DNS and doesn't route
 * maintainer-domain queries through fixed public resolvers (which would leak that you ran the check
 * to an attacker-chosen authoritative server). Set `SANDBOX_DNS_SERVERS` (comma-separated IPs) to
 * override; an invalid override falls back to the system resolver rather than disabling the signal.
 */
export function defaultNsResolver(timeoutMs: number): Resolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const override = process.env.SANDBOX_DNS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (override?.length) {
    try {
      resolver.setServers(override);
    } catch {
      // invalid override (bad IP) — keep the system resolver instead of throwing/disabling the check
    }
  }
  return resolver;
}

/** DNS error codes that mean the domain genuinely has no nameservers (expired/parked) — worth flagging. */
const EXPIRED_DNS_CODES = new Set(['ENOTFOUND', 'NOTFOUND', 'NXDOMAIN', 'ENODATA']);

function emailDomain(email: string | undefined): string | undefined {
  if (!email || !email.includes('@')) return undefined;
  const domain = email.slice(email.indexOf('@') + 1).trim().toLowerCase();
  return domain && domain.includes('.') ? domain : undefined;
}

/** The publishable accounts' email domains for a resolved package (current maintainers + this publisher). */
function maintainerDomains(pkg: ResolvedTarget): string[] {
  const emails = [
    ...(pkg.packument.maintainers ?? []).map((m) => m.email),
    pkg.packument.versions[pkg.version]?._npmUser?.email,
  ];
  return [...new Set(emails.map(emailDomain).filter((d): d is string => Boolean(d)))];
}

/**
 * Flag packages whose maintainer email domain no longer resolves — a lapsed domain can be
 * re-registered to seize the npm account (account-takeover via password reset). One NS lookup per
 * distinct domain (shared across packages), and ONLY a definitive "domain does not exist" error
 * flags: timeouts and transient DNS failures are inconclusive and produce no hint (fail open).
 */
export async function expiredDomainHints(
  resolved: ResolvedTarget[],
  opts: { resolver?: NsResolver; timeoutMs?: number; concurrency?: number } = {},
): Promise<RiskHint[]> {
  const resolver = opts.resolver ?? defaultNsResolver(opts.timeoutMs ?? 3000);
  const domains = [...new Set(resolved.flatMap(maintainerDomains))];
  if (!domains.length) return [];

  const expired = new Set<string>();
  await mapPool(domains, opts.concurrency ?? 8, async (domain) => {
    try {
      const ns = await resolver.resolveNs(domain);
      if (!ns || ns.length === 0) expired.add(domain); // resolves but no nameservers → unusable domain
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && EXPIRED_DNS_CODES.has(code)) expired.add(domain); // definitive: domain doesn't exist
      // any other error (timeout, refused, servfail) is inconclusive — fail open, no hint
    }
  });

  const hints: RiskHint[] = [];
  for (const pkg of resolved) {
    const bad = maintainerDomains(pkg).find((d) => expired.has(d));
    if (bad) {
      hints.push({
        level: 'error',
        code: 'expired_domain',
        package: pkg.name,
        version: pkg.version,
        message: `maintainer email domain "${bad}" no longer resolves, can be re-registered for account takeover`,
        detail: { domain: bad },
      });
    }
  }
  return hints;
}

export interface DownloadsClient {
  lastMonth(name: string): Promise<number | undefined>;
}

/** npm's downloads "point" API. Returns undefined (not 0) when unknown so callers don't false-flag. */
export function createDownloadsClient(fetchImpl: typeof fetch = fetch, timeoutMs = REGISTRY_TIMEOUT_MS): DownloadsClient {
  return {
    async lastMonth(name: string): Promise<number | undefined> {
      // The point endpoint doesn't support scoped packages — skip rather than mis-report.
      if (name.startsWith('@')) return undefined;
      try {
        const res = await fetchImpl(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as unknown;
        return isRecord(body) && typeof body.downloads === 'number' ? body.downloads : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Flag packages with almost no monthly downloads — on its own that's just an unpopular package, but
 * paired with a fresh publish or an install script it's the profile of a typosquat/throwaway. Fails
 * open per package (unknown download count → no hint).
 */
export async function lowDownloadHints(
  resolved: ResolvedTarget[],
  opts: { client?: DownloadsClient; threshold?: number; concurrency?: number } = {},
): Promise<RiskHint[]> {
  const client = opts.client ?? createDownloadsClient();
  const threshold = opts.threshold ?? LOW_DOWNLOADS_THRESHOLD;
  const counts = await mapPool(resolved, opts.concurrency ?? 8, async (pkg) => ({ pkg, downloads: await client.lastMonth(pkg.name) }));
  const hints: RiskHint[] = [];
  for (const { pkg, downloads } of counts) {
    if (downloads !== undefined && downloads <= threshold) {
      hints.push({
        level: 'warn',
        code: 'low_downloads',
        package: pkg.name,
        version: pkg.version,
        message: `only ${downloads} downloads last month; very low usage`,
        detail: { downloads },
      });
    }
  }
  return hints;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanResolvedVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const raw = stripQuotes(value).trim();
  if (!raw || isUnsupportedSpec(raw)) return undefined;
  const bare = raw.startsWith('version ') ? raw.slice('version '.length).trim() : raw;
  const core = bare.replace(/\([^)]*\).*$/, '');
  return parseSemver(core) ? core : undefined;
}

function parseNpmLockfile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const lock = JSON.parse(text) as NpmLockfile;
    for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
      if (!pkgPath.startsWith('node_modules/')) continue;
      const name = pkgPath.slice('node_modules/'.length);
      const version = cleanResolvedVersion(meta.version);
      if (name && version) out.set(name, version);
    }
    for (const [name, meta] of Object.entries(lock.dependencies ?? {})) {
      const version = cleanResolvedVersion(meta.version);
      if (version && !out.has(name)) out.set(name, version);
    }
  } catch {
    return out;
  }
  return out;
}

function parsePnpmScalar(value: string): string | undefined {
  const cleaned = cleanResolvedVersion(value);
  if (cleaned) return cleaned;
  const match = /version:\s*("?[^"\s]+"?)/.exec(value);
  return cleanResolvedVersion(match?.[1]);
}

function parsePnpmLockfile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let inImporters = false;
  let inRootImporter = false;
  let currentSection: 'dependencies' | 'devDependencies' | 'optionalDependencies' | undefined;
  let currentDep: string | undefined;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!inImporters) {
      if (/^importers:\s*$/.test(line)) inImporters = true;
      continue;
    }
    if (!inRootImporter) {
      if (/^  \.:\s*$/.test(line)) {
        inRootImporter = true;
        continue;
      }
      if (/^  \S/.test(line)) break;
      continue;
    }
    if (/^  \S/.test(line) && !/^  \.:\s*$/.test(line)) break;
    const sectionMatch = /^    (dependencies|devDependencies|optionalDependencies):\s*$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1] as typeof currentSection;
      currentDep = undefined;
      continue;
    }
    if (!currentSection) continue;
    const versionMatch = currentDep ? /^        version:\s+(.+)\s*$/.exec(line) : undefined;
    if (versionMatch && currentDep) {
      const version = cleanResolvedVersion(versionMatch[1]);
      if (version) out.set(currentDep, version);
      continue;
    }
    const depMatch = /^      ([^:\s][^:]*):(?:\s+(.*))?$/.exec(line);
    if (depMatch) {
      currentDep = stripQuotes(depMatch[1] ?? '');
      const inline = depMatch[2]?.trim();
      const version = parsePnpmScalar(inline ?? '');
      if (currentDep && version) out.set(currentDep, version);
      continue;
    }
  }
  return out;
}

function splitTopLevelCommaList(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseYarnLockfile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let selectors: string[] = [];
  let version: string | undefined;

  const flush = () => {
    const resolved = cleanResolvedVersion(version);
    if (!resolved) return;
    for (const selector of selectors) out.set(stripQuotes(selector), resolved);
  };

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!line.startsWith(' ') && line.endsWith(':')) {
      flush();
      selectors = splitTopLevelCommaList(line.slice(0, -1)).map(stripQuotes);
      version = undefined;
      continue;
    }
    const versionMatch = /^\s+version\s+(.+)\s*$/.exec(line);
    if (versionMatch) version = versionMatch[1];
  }
  flush();
  return out;
}

export function readDirectVersionsFromLockfile(cwd: string, pm: PackageManager): Map<string, string> {
  const file = path.join(cwd, lockfileName(pm));
  if (!existsSync(file)) return new Map();
  const text = readFileSync(file, 'utf8');
  switch (pm) {
    case 'npm':
      return parseNpmLockfile(text);
    case 'pnpm':
      return parsePnpmLockfile(text);
    case 'yarn':
      return parseYarnLockfile(text);
    case 'bun':
      // bun.lock is JSONC and bun.lockb is binary; we don't parse either yet, so risk
      // hints fall back to the spec declared in package.json (no exact-version pin).
      return new Map();
  }
}

export interface LockfilePackage {
  name: string;
  version: string;
}

/** All resolved packages in an npm lockfile, including transitive (every `node_modules/...` entry). */
function allNpmPackages(text: string): LockfilePackage[] {
  const out: LockfilePackage[] = [];
  try {
    const lock = JSON.parse(text) as NpmLockfile;
    for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
      const marker = pkgPath.lastIndexOf('node_modules/');
      if (marker === -1) continue;
      const name = pkgPath.slice(marker + 'node_modules/'.length);
      const version = cleanResolvedVersion(meta.version);
      if (name && version) out.push({ name, version });
    }
  } catch {
    return out;
  }
  return out;
}

/** Decode a pnpm `packages:` key (`/name/1.2.3`, `name@1.2.3`, `@scope/n@1.2.3`, peer suffixes). */
function pnpmKeyToPackage(rawKey: string): LockfilePackage | undefined {
  let key = stripQuotes(rawKey.trim()).replace(/\(.*\)$/, '');
  if (key.startsWith('/')) {
    const rest = key.slice(1);
    const slash = rest.lastIndexOf('/');
    if (slash <= 0) return undefined;
    const version = cleanResolvedVersion(rest.slice(slash + 1));
    return version ? { name: rest.slice(0, slash), version } : undefined;
  }
  const at = key.lastIndexOf('@');
  if (at <= 0) return undefined;
  const version = cleanResolvedVersion(key.slice(at + 1));
  return version ? { name: key.slice(0, at), version } : undefined;
}

/** All packages in a pnpm lockfile's top-level `packages:` section (the full resolved tree). */
function allPnpmPackages(text: string): LockfilePackage[] {
  const out: LockfilePackage[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!inPackages) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      continue;
    }
    if (/^\S/.test(line)) break; // next top-level section
    const keyMatch = /^  (\S.*):\s*$/.exec(line); // 2-space indent, ends with colon
    if (keyMatch) {
      const pkg = pnpmKeyToPackage(keyMatch[1]!);
      if (pkg) out.push(pkg);
    }
  }
  return out;
}

/** Strip the `@range` selector off a yarn key (`@scope/n@^1` -> `@scope/n`). */
function yarnSelectorName(selector: string): string {
  const at = selector.lastIndexOf('@');
  return at > 0 ? selector.slice(0, at) : selector;
}

/**
 * Every (name, version) a lockfile would install, transitive included — the input to the `--deep`
 * release-age gate. npm and pnpm get full-tree coverage; yarn is derived from its resolved
 * selectors; bun has no parser yet, so callers fall back to the direct-deps gate with a warning.
 */
export function readAllPackagesFromLockfile(cwd: string, pm: PackageManager): LockfilePackage[] {
  const file = path.join(cwd, lockfileName(pm));
  if (!existsSync(file)) return [];
  return parseLockfilePackages(readFileSync(file, 'utf8'), pm);
}

/**
 * Parse a lockfile's full resolved tree from raw text. Split from
 * {@link readAllPackagesFromLockfile} so callers can diff a *base* lockfile read straight from a git
 * blob (`git show <ref>:<lockfile>`) without writing it to disk. bun has no parser yet, so it yields [].
 */
export function parseLockfilePackages(text: string, pm: PackageManager): LockfilePackage[] {
  switch (pm) {
    case 'npm':
      return allNpmPackages(text);
    case 'pnpm':
      return allPnpmPackages(text);
    case 'yarn':
      return [...parseYarnLockfile(text)].map(([selector, version]) => ({ name: yarnSelectorName(selector), version }));
    case 'bun':
      return [];
  }
}

function resolveExactDirectVersion(name: string, spec: string, pm: PackageManager, versions: Map<string, string>): string | undefined {
  if (pm === 'yarn') {
    return versions.get(`${name}@${spec}`) ?? (spec ? undefined : versions.get(name));
  }
  return versions.get(name);
}

export async function resolveRiskTargets(targets: RiskTarget[], client: RegistryClient): Promise<ResolvedTarget[]> {
  const out: ResolvedTarget[] = [];
  for (const target of targets) {
    const packument = await client.getPackument(target.name);
    const version = resolveVersion(target.spec, packument);
    if (!version) continue;
    const manifest = packument.versions[version];
    if (!manifest) continue;
    out.push({
      name: target.name,
      spec: target.spec,
      version,
      manifest,
      createdAt: parseDate(packument.time?.created),
      publishedAt: parseDate(packument.time?.[version]),
      packument,
    });
  }
  return out;
}

export async function collectRiskHints(
  targets: RiskTarget[],
  opts: { client?: RegistryClient; now?: Date } = {},
): Promise<RiskHint[]> {
  const client = opts.client ?? createRegistryClient();
  const now = opts.now ?? new Date();
  return hintsFromResolved(await resolveRiskTargets(targets, client), now);
}

/**
 * Pure hint computation over already-resolved targets. Split out from {@link collectRiskHints} so
 * the preflight can resolve the registry ONCE and feed the same `resolved` set to the hints, the
 * release-age gate, and the advisory check, instead of each resolving independently.
 */
export function hintsFromResolved(resolved: ResolvedTarget[], now: Date): RiskHint[] {
  const hints: RiskHint[] = [];
  const corpus = loadTopPackages();
  for (const pkg of resolved) {
    const similarTo = typosquatMatches(pkg.name, corpus);
    if (similarTo.length) {
      hints.push({
        level: 'error',
        code: 'typosquat',
        package: pkg.name,
        version: pkg.version,
        message: `name is within 1–2 edits of popular package${similarTo.length === 1 ? '' : 's'}: ${similarTo.slice(0, 3).join(', ')}; possible typosquat`,
        detail: { similarTo },
      });
    }
    const priorProvenance = priorVersionWithProvenance(pkg.packument, pkg.version);
    if (priorProvenance && !pkg.manifest.dist?.attestations) {
      hints.push({
        level: 'error',
        code: 'provenance_regression',
        package: pkg.name,
        version: pkg.version,
        message: `version ${priorProvenance} shipped npm provenance but ${pkg.version} dropped it, release-path change`,
        detail: { priorVersion: priorProvenance },
      });
    }
    const maintainer = maintainerChangeHint(pkg, now);
    if (maintainer) hints.push(maintainer);
    const missing = missingMetadata(pkg.manifest);
    if (missing.length) {
      hints.push({
        level: 'warn',
        code: 'missing_metadata',
        package: pkg.name,
        version: pkg.version,
        message: `missing ${missing.join(' and ')} metadata; lower-trust package`,
        detail: { missing },
      });
    }
    for (const script of INSTALL_SCRIPTS) {
      if (pkg.manifest.scripts?.[script]) {
        hints.push({
          level: 'warn',
          code: 'install_script',
          package: pkg.name,
          version: pkg.version,
          message: `has ${script} script (runs on your host during install)`,
          detail: { script },
        });
      }
    }
    if (pkg.publishedAt) {
      const age = now.getTime() - pkg.publishedAt.getTime();
      if (age >= 0 && age < RECENT_VERSION_LIGHT_MS) {
        // Newest release that already predates the worm window, computed from the packument we already
        // hold (no extra fetch). Dropped when it would just point back at the flagged version itself.
        const olderRelease = selectAgedVersion(pkg.packument, RECENT_VERSION_LIGHT_MS, now);
        const aged = olderRelease && olderRelease.version !== pkg.version ? { version: olderRelease.version, ageMs: olderRelease.ageMs } : undefined;
        hints.push({
          level: age < RECENT_VERSION_STRONG_MS ? 'error' : 'warn',
          code: 'recent_version',
          package: pkg.name,
          version: pkg.version,
          message: `${age < RECENT_VERSION_STRONG_MS ? 'very recently published' : 'recently published'} ${humanAge(age)}; fresh releases are the supply-chain worm window`,
          detail: { publishedAt: pkg.publishedAt.toISOString(), severity: age < RECENT_VERSION_STRONG_MS ? 'strong' : 'light', aged } satisfies RecentVersionDetail,
        });
      }
    }
    if (pkg.createdAt) {
      const age = now.getTime() - pkg.createdAt.getTime();
      if (age >= 0 && age < NEW_PACKAGE_MS) {
        hints.push({
          level: 'warn',
          code: 'new_package',
          package: pkg.name,
          version: pkg.version,
          message: `first published ${humanAge(age)}; still a young package`,
          detail: { createdAt: pkg.createdAt.toISOString() },
        });
      }
    }
    const bin = binDetail(pkg.manifest.bin);
    if (bin) {
      hints.push({
        level: 'warn',
        code: 'bin_exposed',
        package: pkg.name,
        version: pkg.version,
        message: `exposes a command-line binary`,
        detail: { bin },
      });
    }
    if (pkg.manifest.deprecated) {
      hints.push({
        level: 'warn',
        code: 'deprecated',
        package: pkg.name,
        version: pkg.version,
        message: `deprecated: ${pkg.manifest.deprecated}`,
        detail: { deprecated: pkg.manifest.deprecated },
      });
    }
  }
  return hints;
}

/** A known-good older version to pin: the newest stable release already past the age threshold. */
export interface AgedVersion {
  version: string;
  publishedAt: Date;
  ageMs: number;
}

/**
 * Pure: newest stable (non-prerelease, non-deprecated) version in an already-fetched packument that
 * has aged past `minAgeMs`. The selection behind both the release-age pin suggestion and the
 * freshness hint's "an older release predates the window" line. Age is the only claim — never "safe".
 */
export function selectAgedVersion(packument: Packument, minAgeMs: number, now: Date): AgedVersion | undefined {
  const time = packument.time ?? {};
  const aged = Object.entries(packument.versions)
    .map(([version, manifest]) => ({ version, manifest, parsed: parseSemver(version), publishedAt: parseDate(time[version]) }))
    .filter((c): c is typeof c & { parsed: Semver; publishedAt: Date } => Boolean(c.parsed) && c.parsed!.prerelease.length === 0 && !c.manifest.deprecated && Boolean(c.publishedAt) && now.getTime() - c.publishedAt!.getTime() >= minAgeMs)
    .sort((a, b) => compareSemver(a.parsed, b.parsed));
  const best = aged.at(-1);
  return best ? { version: best.version, publishedAt: best.publishedAt, ageMs: now.getTime() - best.publishedAt.getTime() } : undefined;
}

/**
 * The newest stable version of `name` already aged past `minAgeMs` — the concrete "pin an older
 * version" answer when the release-age gate blocks the latest. Fetches the packument, then defers to
 * {@link selectAgedVersion}. Returns undefined when the registry is unreachable (fail open) or nothing qualifies.
 */
export async function suggestAgedVersion(name: string, minAgeMs: number, opts: { client?: RegistryClient; now?: Date } = {}): Promise<AgedVersion | undefined> {
  const client = opts.client ?? createRegistryClient();
  const now = opts.now ?? new Date();
  try {
    return selectAgedVersion(await client.getPackument(name), minAgeMs, now);
  } catch {
    return undefined; // fail open — no suggestion rather than a hard error on the block path
  }
}

/** A package whose to-be-installed version is younger than the release-age threshold. */
export interface ReleaseAgeViolation {
  name: string;
  version: string;
  publishedAt: Date;
  ageMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: which resolved targets were published more recently than `minAgeMs`. This is the
 * supply-chain "cooldown" control — the worms in this class publish-and-detonate within hours,
 * so refusing versions younger than a few days defeats the publish→install window entirely.
 */
export function releaseAgeViolations(resolved: ResolvedTarget[], minAgeMs: number, now: Date): ReleaseAgeViolation[] {
  const out: ReleaseAgeViolation[] = [];
  for (const pkg of resolved) {
    if (!pkg.publishedAt) continue;
    const ageMs = now.getTime() - pkg.publishedAt.getTime();
    if (ageMs >= 0 && ageMs < minAgeMs) out.push({ name: pkg.name, version: pkg.version, publishedAt: pkg.publishedAt, ageMs });
  }
  return out;
}

/** Compile a name pattern (`*` glob, e.g. `@scope/*`, `internal-*`) into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Does `name` match any of the exclude patterns? Used to exempt your own scope from the gate. */
export function isExcluded(name: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegExp(p).test(name));
}

/**
 * Resolve `targets` against the registry and return any whose installable version is younger
 * than `minAgeDays`. Used as a *blocking* preflight (unlike the advisory {@link collectRiskHints}):
 * the install never starts if a fresh version would be pulled. `exclude` exempts package-name
 * patterns (your own freshly-published scope) so the gate doesn't block your own releases.
 */
export async function checkReleaseAge(targets: RiskTarget[], minAgeDays: number, opts: { client?: RegistryClient; now?: Date; exclude?: string[] } = {}): Promise<ReleaseAgeViolation[]> {
  const client = opts.client ?? createRegistryClient();
  const now = opts.now ?? new Date();
  const exclude = opts.exclude ?? [];
  const checked = targets.filter((t) => !isExcluded(t.name, exclude));
  const resolved = await resolveRiskTargets(checked, client);
  return releaseAgeViolations(resolved, minAgeDays * DAY_MS, now);
}

/**
 * Map over `items` with bounded concurrency (registry/OSV lookups, so cap the in-flight requests).
 * Order of results is not significant for our callers, so a simple worker pool is enough.
 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** What a deep tree scan found: fresh versions (release-age) and maintainer-deprecated versions. */
export interface DeepScan {
  ageViolations: ReleaseAgeViolation[];
  /** Deprecated-version findings as the same `code: 'deprecated'` hints the direct path emits. */
  deprecated: RiskHint[];
}

/**
 * Scan every (name, version) the lockfile would install — not just direct deps — for the BLOCKING
 * signals derivable from the registry: release age and maintainer deprecation. Groups by name so it
 * fetches ONE packument per package (bounded concurrency), and reads both the publish time and the
 * `deprecated` flag of each pinned version from that single response — so deep-deprecated costs no
 * extra requests on top of the age scan. Fails open per package (an unreachable name is skipped).
 */
export async function scanDeepTree(
  packages: Array<{ name: string; version: string }>,
  opts: { client?: RegistryClient; now?: Date; exclude?: string[]; concurrency?: number; minReleaseAgeDays?: number; deprecations?: boolean } = {},
): Promise<DeepScan> {
  const client = opts.client ?? createRegistryClient();
  const now = opts.now ?? new Date();
  const exclude = opts.exclude ?? [];
  const minAgeMs = (opts.minReleaseAgeDays ?? 0) * DAY_MS;
  const wantAge = minAgeMs > 0;
  const wantDeprecated = opts.deprecations ?? false;

  // Group pinned versions by package name; skip excluded scopes before any lookup.
  const byName = new Map<string, Set<string>>();
  for (const { name, version } of packages) {
    if (isExcluded(name, exclude)) continue;
    (byName.get(name) ?? byName.set(name, new Set()).get(name)!).add(version);
  }

  const names = [...byName.keys()];
  const per = await mapPool(names, opts.concurrency ?? 8, async (name): Promise<DeepScan> => {
    let packument: Packument;
    try {
      packument = await client.getPackument(name);
    } catch {
      return { ageViolations: [], deprecated: [] }; // fail open per package — one bad name can't sink the scan
    }
    const ageViolations: ReleaseAgeViolation[] = [];
    const deprecated: RiskHint[] = [];
    for (const version of byName.get(name)!) {
      if (wantAge) {
        const publishedAt = parseDate(packument.time?.[version]);
        if (publishedAt) {
          const ageMs = now.getTime() - publishedAt.getTime();
          if (ageMs >= 0 && ageMs < minAgeMs) ageViolations.push({ name, version, publishedAt, ageMs });
        }
      }
      if (wantDeprecated) {
        const reason = packument.versions[version]?.deprecated;
        if (reason) deprecated.push({ level: 'warn', code: 'deprecated', package: name, version, message: `deprecated: ${reason}`, detail: { deprecated: reason } });
      }
    }
    return { ageViolations, deprecated };
  });

  return { ageViolations: per.flatMap((p) => p.ageViolations), deprecated: per.flatMap((p) => p.deprecated) };
}

/**
 * Deep release-age check: every (name, version) the lockfile would install, flagged when younger
 * than the threshold. Thin wrapper over {@link scanDeepTree} (age only) — kept for callers that want
 * just the age axis. This closes the transitive gap the direct-only gate leaves open.
 */
export async function checkReleaseAgeDeep(packages: Array<{ name: string; version: string }>, minAgeDays: number, opts: { client?: RegistryClient; now?: Date; exclude?: string[]; concurrency?: number } = {}): Promise<ReleaseAgeViolation[]> {
  const { ageViolations } = await scanDeepTree(packages, { ...opts, minReleaseAgeDays: minAgeDays, deprecations: false });
  return ageViolations;
}
