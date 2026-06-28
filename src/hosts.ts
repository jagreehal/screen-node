/**
 * Classify an egress host into a plain-English category, so the human in the loop can make an
 * *informed* allow/deny decision instead of rubber-stamping a bare hostname. The default-deny
 * boundary is only as good as the moment someone widens it — annotating "this is the Node
 * headers host, native modules need it" vs "this is not a known registry or build host" is what
 * turns that moment from approval fatigue into a real check.
 *
 * Used by the interactive egress prompt and (later) `--dry-run --explain`. Pure data → no I/O.
 */

export type HostCategory = 'registry' | 'native-build' | 'git-source' | 'cdn' | 'unknown';

export interface HostClassification {
  host: string;
  category: HostCategory;
  /** One-line reason, written for someone deciding whether to allow it. */
  why: string;
  /** True for hosts a normal, honest install commonly and legitimately contacts. */
  commonForInstall: boolean;
}

interface HostRule {
  /** Apex/suffix to match: `host === suffix` or `host` endsWith `.suffix` (anchored, like the proxy). */
  suffix: string;
  category: HostCategory;
  why: string;
  common: boolean;
}

/**
 * Curated set of hosts a Node install legitimately reaches: the public registries, the Node
 * headers host (node-gyp), git sources, and the handful of vendor CDNs that popular packages
 * download prebuilt binaries from at postinstall. Anything not here is reported as `unknown` —
 * not "bad", but "worth a look before you allow it".
 */
const HOST_RULES: readonly HostRule[] = [
  { suffix: 'npmjs.org', category: 'registry', why: 'the public npm registry', common: true },
  { suffix: 'npmjs.com', category: 'registry', why: 'the public npm registry', common: true },
  { suffix: 'yarnpkg.com', category: 'registry', why: 'the Yarn registry mirror', common: true },
  { suffix: 'npmmirror.com', category: 'registry', why: 'a public npm registry mirror', common: true },
  { suffix: 'jsr.io', category: 'registry', why: 'the JSR registry', common: true },
  { suffix: 'nodejs.org', category: 'native-build', why: 'Node headers for compiling native modules (node-gyp)', common: true },
  { suffix: 'github.com', category: 'git-source', why: 'a git/GitHub dependency or a release binary', common: true },
  { suffix: 'githubusercontent.com', category: 'cdn', why: 'a GitHub-hosted file or release asset', common: true },
  { suffix: 'gitlab.com', category: 'git-source', why: 'a git/GitLab dependency', common: true },
  { suffix: 'codeberg.org', category: 'git-source', why: 'a git dependency', common: true },
  { suffix: 'binaries.prisma.sh', category: 'native-build', why: 'Prisma engine binaries (postinstall download)', common: true },
  { suffix: 'playwright.azureedge.net', category: 'native-build', why: 'Playwright browser binaries (postinstall download)', common: true },
  { suffix: 'playwright.download.prss.microsoft.com', category: 'native-build', why: 'Playwright browser binaries (postinstall download)', common: true },
  { suffix: 'cdn.playwright.dev', category: 'native-build', why: 'Playwright binaries (postinstall download)', common: true },
  { suffix: 'download.cypress.io', category: 'native-build', why: 'the Cypress test-runner binary (postinstall download)', common: true },
  { suffix: 'storage.googleapis.com', category: 'cdn', why: 'Google Cloud Storage, often a Chromium/Puppeteer download', common: true },
  { suffix: 'electronjs.org', category: 'native-build', why: 'Electron binaries (postinstall download)', common: true },
];

/** Categories that fetch binaries/headers/source during install — the "build host" bundle. */
const BUILD_HOST_CATEGORIES: ReadonlySet<HostCategory> = new Set(['native-build', 'cdn', 'git-source']);

/**
 * The curated hosts a native/postinstall build legitimately downloads from (Node headers, GitHub
 * release assets, Prisma/Playwright/Cypress/Electron binaries, …). Derived from {@link HOST_RULES}
 * so there's one source of truth — `--allow-build-hosts` and the `build-tools` host group both use it.
 * Registries are deliberately excluded (a different trust concern; the PM's own registry is handled
 * separately).
 */
export function buildHostSuffixes(): string[] {
  return HOST_RULES.filter((r) => BUILD_HOST_CATEGORIES.has(r.category)).map((r) => r.suffix);
}

/** The bare host (lowercased, no port) — tolerant of accidental `host:port` or trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
}

/** Anchored suffix match: `registry.npmjs.org` matches `npmjs.org`, `npmjs.org.evil.com` does not. */
function matches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Classify a single host against the curated table; unknown hosts fall through to a cautious default. */
export function classifyHost(rawHost: string): HostClassification {
  const host = normalizeHost(rawHost);
  for (const rule of HOST_RULES) {
    if (matches(host, rule.suffix)) {
      return { host, category: rule.category, why: rule.why, commonForInstall: rule.common };
    }
  }
  return {
    host,
    category: 'unknown',
    why: 'not a known registry or build host, unusual for an install to contact',
    commonForInstall: false,
  };
}

export interface DescribeHostsOptions {
  /** This project's own registry hosts (from `.npmrc`); annotated as the configured registry. */
  registryHosts?: string[];
}

/**
 * Annotate each blocked host for the prompt. A host that matches the project's configured
 * private/scoped registry is the expected case and labelled as such; everything else is
 * classified against the curated table.
 */
export function describeBlockedHosts(hosts: string[], opts: DescribeHostsOptions = {}): HostClassification[] {
  const registry = new Set((opts.registryHosts ?? []).map(normalizeHost));
  return hosts.map((raw) => {
    const host = normalizeHost(raw);
    if (registry.has(host)) {
      return { host, category: 'registry', why: 'your configured registry (from .npmrc)', commonForInstall: true };
    }
    return classifyHost(host);
  });
}

/** A glyph that reads at a glance: a check for hosts a real install needs, a warning for the rest. */
export function hostGlyph(c: HostClassification): string {
  return c.commonForInstall ? '✓' : '⚠';
}

/** One annotated line per blocked host, e.g. `⚠ exfil.example.com, not a known registry or build host…`. */
export function renderBlockedHostLines(classifications: HostClassification[]): string {
  return classifications.map((c) => `  ${hostGlyph(c)} ${c.host}, ${c.why}`).join('\n');
}
