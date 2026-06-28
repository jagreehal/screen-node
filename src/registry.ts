import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localConfigPath, readCommittedConfig, type SandboxConfig, stripJsonComments, writeConfig } from './config.js';

export interface RegistryHints {
  hosts: string[];
  authEnvNames: string[];
}

export interface RegistryDiagnostics {
  hints: RegistryHints;
  missingAllowHosts: string[];
  missingEnvGrants: string[];
  unsetHostEnv: string[];
}

/**
 * The bare host (`registry.npmjs.org`, with port if present) from any of the forms a
 * registry/allowlist entry takes: a full URL (`https://registry.npmjs.org/`), an npmrc
 * scheme-relative auth line (`//registry.npmjs.org/:_authToken=…`), or a bare host
 * (`registry.npmjs.org`, `registry.local:4873/path`). One parser so `sandbox allow` and
 * the `.npmrc` detector agree on what a host is.
 */
function hostFrom(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.includes('://')) {
    try {
      return new URL(value).host || undefined;
    } catch {
      return undefined;
    }
  }
  return value.replace(/^\/\//, '').replace(/\/.*$/, '') || undefined;
}

export function readProjectNpmrc(cwd: string): string | undefined {
  const file = path.join(cwd, '.npmrc');
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8');
}

export function detectRegistryHints(text: string): RegistryHints {
  const hosts = new Set<string>();
  const authEnvNames = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const [key, ...rest] = line.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=').trim();
    if (key === 'registry' || key.endsWith(':registry')) {
      const host = hostFrom(value);
      if (host) hosts.add(host);
    }
    const envRefs = value.matchAll(/\$\{([A-Z0-9_]+)\}/g);
    for (const match of envRefs) {
      const name = match[1];
      if (name) authEnvNames.add(name);
    }
  }
  return {
    hosts: [...hosts].sort(),
    authEnvNames: [...authEnvNames].sort(),
  };
}

export function projectRegistryHints(cwd: string): RegistryHints {
  const npmrc = readProjectNpmrc(cwd);
  return npmrc ? detectRegistryHints(npmrc) : { hosts: [], authEnvNames: [] };
}

/**
 * Dependency names that signal a native build at install time. node-gyp downloads Node headers
 * from `nodejs.org`, and the gyp/prebuild toolchain packages are the load-bearing direct signal;
 * a `binding.gyp` in the tree is the other. Detecting these lets `init`/`setup` pre-allow
 * `nodejs.org` so the most common first-run egress failure ("native module can't fetch headers")
 * doesn't happen at all.
 */
const NATIVE_BUILD_DEPS = new Set([
  'node-gyp',
  'node-gyp-build',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'prebuild-install',
  'prebuildify',
  'node-addon-api',
  'nan',
  'cmake-js',
]);

/** True when the project's deps or tree indicate a native (node-gyp/prebuild) build on install. */
function hasNativeBuildIndicators(cwd: string, depNames: string[]): boolean {
  if (existsSync(path.join(cwd, 'binding.gyp'))) return true;
  return depNames.some((name) => NATIVE_BUILD_DEPS.has(name));
}

/**
 * Hosts an install in `cwd` is likely to need beyond the npm registry, so `init`/`setup` can
 * pre-fill `egress.allow` and the first run "just works" instead of failing on a blocked host.
 * Sources: a private/scoped registry in `.npmrc`; `github.com`/`codeload.github.com` when any
 * dependency is a git/github spec; and `nodejs.org` when the project has native-build indicators
 * (a node-gyp/prebuild dependency or a `binding.gyp`), since node-gyp fetches Node headers from
 * there. Only these high-confidence, ubiquitous hosts are pre-filled; the long tail of vendor
 * binary CDNs is surfaced (annotated) by the interactive egress prompt instead of auto-allowed.
 */
export function detectEgressHosts(cwd: string): string[] {
  const hosts = new Set<string>(projectRegistryHints(cwd).hosts);
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    const specs: string[] = [];
    const depNames: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const group = pkg[field];
      if (group && typeof group === 'object') {
        depNames.push(...Object.keys(group as Record<string, unknown>));
        specs.push(...Object.values(group as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
      }
    }
    if (specs.some((spec) => /^(github:|git\+|git:)/.test(spec) || spec.includes('github.com'))) {
      hosts.add('github.com');
      hosts.add('codeload.github.com');
    }
    if (hasNativeBuildIndicators(cwd, depNames)) hosts.add('nodejs.org');
  } catch {
    // no/invalid package.json — fall back to registry hints (+ a bare binding.gyp if present)
    if (existsSync(path.join(cwd, 'binding.gyp'))) hosts.add('nodejs.org');
  }
  return [...hosts].sort();
}

export function missingAllowHosts(currentAllow: string[], wantedHosts: string[]): string[] {
  const allow = new Set(currentAllow.map((host) => host.toLowerCase()));
  return [...new Set(wantedHosts)]
    .filter((host) => !allow.has(host.toLowerCase()))
    .sort();
}

export function registryDiagnostics(cwd: string, config: SandboxConfig, hostEnv: NodeJS.ProcessEnv = process.env): RegistryDiagnostics {
  const hints = projectRegistryHints(cwd);
  return {
    hints,
    missingAllowHosts: missingAllowHosts(config.egress.allow, hints.hosts),
    missingEnvGrants: hints.authEnvNames.filter((name) => !config.grants.env.includes(name)),
    unsetHostEnv: hints.authEnvNames.filter((name) => hostEnv[name] === undefined),
  };
}

export function renderAllowCommand(hosts: string[]): string {
  return `screen allow ${hosts.join(' ')}`;
}

export function renderAllowlistSnippet(currentAllow: string[], addHosts: string[]): string {
  const next = [...new Set([...currentAllow, ...addHosts])].sort();
  return JSON.stringify({ egress: { allow: next } }, null, 2);
}

export function allowHosts(cwd: string, hosts: string[], configPath?: string): { file: string; added: string[]; allow: string[] } {
  const file = configPath ?? path.join(cwd, 'screen.config.json');
  // Project layer ONLY — never the merged effective config, or a personal user-global/local
  // override (a loosened network, an extra grant) would be written into the committed team file.
  const config = readCommittedConfig(cwd, configPath);
  const normalized = hosts.map(hostFrom).filter((host): host is string => Boolean(host));
  const added = missingAllowHosts(config.egress.allow, normalized);
  const allow = [...new Set([...config.egress.allow, ...normalized])].sort();
  writeConfig(file, { ...config, egress: { ...config.egress, allow } });
  return { file, added, allow };
}

/**
 * Add hosts to the personal, git-ignored override layer (`screen.config.local.json`) instead of
 * the committed team config — the "allow for me, not everyone" path from the interactive prompt.
 * Writes a minimal partial (only `egress.allow`, only the hosts this layer adds) so it stays a
 * small, readable personal delta and never duplicates the whole team allowlist. Other fields the
 * user already has in their local file are preserved.
 *
 * The local file is the sibling of the ACTIVE project config, so pass `configPath` through when the
 * user ran with `--config <path>` — otherwise the override is written next to the wrong file and
 * the next run won't load it. Defaults to `<rootDir>/screen.config.json`'s sibling.
 */
export function allowHostsLocal(rootDir: string, hosts: string[], configPath?: string): { file: string; added: string[] } {
  const file = localConfigPath(configPath ?? path.join(rootDir, 'screen.config.json'));
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  }
  const egress = (existing.egress && typeof existing.egress === 'object' ? existing.egress : {}) as { allow?: unknown };
  const current = Array.isArray(egress.allow) ? (egress.allow as string[]) : [];
  const normalized = hosts.map(hostFrom).filter((host): host is string => Boolean(host));
  const added = missingAllowHosts(current, normalized);
  const allow = [...new Set([...current, ...normalized])].sort();
  writeFileSync(file, `${JSON.stringify({ ...existing, egress: { ...egress, allow } }, null, 2)}\n`);
  return { file, added };
}
