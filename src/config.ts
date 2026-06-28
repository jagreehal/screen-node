import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { isValidPortSpec } from './ports.js';

/** Network policy for a phase: no egress, full bridge, or default-deny allowlist. */
export const NetworkMode = z.enum(['none', 'on', 'allowlist']);
export type NetworkMode = z.infer<typeof NetworkMode>;

/**
 * A port to publish. Accepts a number (`4321`) or string — bare (`"4321"`), `"HOST:CONTAINER"`,
 * or `"IP:HOST:CONTAINER"`. We keep the value as-is (no transform — that can't be expressed in
 * JSON Schema, which the committed `sandbox.schema.json` is generated from); `normalizePort`
 * coerces a number and expands a bare port to `HOST:CONTAINER` at plan time. The `.refine` turns
 * a typo into a readable message instead of Zod's terse "expected string, received number".
 */
export const PortSpec = z.union([z.string(), z.number().int().positive()]).refine(isValidPortSpec, {
  message: 'invalid port, use a number or "PORT", "HOST:CONTAINER", or "IP:HOST:CONTAINER"',
});

export const SandboxConfigSchema = z
  .object({
    /** Editor JSON Schema reference (enables autocomplete/validation in the config file). */
    $schema: z.string().optional(),
    /**
     * Image tag for the sandbox container. The default is the built-in managed image: it's resolved
     * to a per-fingerprint tag at build time (see `MANAGED_IMAGE` in image.ts), so projects with
     * different package managers / build configs don't clobber one shared `:latest`. Override with a
     * custom name to pin your own image — custom names are used verbatim. Keep this literal in sync
     * with `MANAGED_IMAGE`.
     */
    image: z.string().default('node-install-sandbox:latest'),
    /** Check npm for a newer `sandbox` once a day and print a notice (set false to opt the project out). */
    updateCheck: z.boolean().default(true),
    /**
     * Turn containment OFF for this project: every operation command (`install`/`add`/`run`/`dev`/the
     * pass-through `sandbox npm …`) runs directly on the host, exactly as if you'd typed it without
     * `sandbox`. The escape hatch for a repo you trust — commit it in `sandbox.config.json`, or set it
     * only for yourself in `sandbox.config.local.json`. The env var `SANDBOX_OFF=1` does the same for
     * one command or one shell.
     * Sandbox-only commands (`check`, `doctor`, `init`, `verify`, …) keep working regardless.
     */
    off: z.boolean().default(false),
    grants: z
      .object({
        'ssh-agent': z.boolean().default(false),
        claude: z.enum(['none', 'project', 'home']).default('none'),
        paths: z.array(z.string()).default([]),
        env: z.array(z.string()).default([]),
        envFiles: z.array(z.string()).default([]),
      })
      .strict()
      .default({
        'ssh-agent': false,
        claude: 'none',
        paths: [],
        env: [],
        envFiles: [],
      }),
    install: z
      // Default-deny egress: installs reach only `egress.allow` (the registry),
      // so a malicious lifecycle script can't exfiltrate. Set "on" to opt out.
      // `frozen` = reproducible install (npm ci / --frozen-lockfile); enables a
      // fully read-only source tree on every package manager except pnpm. Requires a committed lockfile.
      .object({
        network: NetworkMode.default('allowlist'),
        frozen: z.boolean().default(false),
        // Pre-install registry signals. "basic" (default) runs the fast packument-only checks
        // (install scripts, fresh/new versions, bins, deprecation, typosquatting, provenance
        // regression, maintainer takeover). "thorough" adds the noisier/network-backed signals
        // (missing metadata, low download counts, expired maintainer domains). "off" disables them.
        riskHints: z.enum(['off', 'basic', 'thorough']).default('basic'),
        failOnRisk: z.boolean().default(false),
        // Release-age gate (the control the 2026-06-04 incident named most effective): refuse to
        // install a package version published fewer than this many days ago. 0 = off. Blocking,
        // not advisory — defeats publish-and-detonate worms by closing the fresh-version window.
        minReleaseAgeDays: z.number().int().min(0).default(0),
        // Package-name patterns exempt from the release-age gate (e.g. your own freshly-published
        // scope). Supports `*` globs: ["@myscope/*", "internal-*"]. The gate would otherwise block
        // your own publishes — this is what the incident response itself had to add.
        minReleaseAgeExclude: z.array(z.string()).default([]),
        // Block installs that pull a version flagged as malware in the OSV advisory database.
        // Different axis from the age gate: "known bad" rather than "too new". Advisory lookups
        // run when riskHints is on; this turns a malware hit into a hard preflight failure.
        failOnAdvisory: z.boolean().default(false),
        // Extra known-malware FEEDS to augment OSV: a list of URLs (e.g. Aikido's public malware
        // database) fetched by `sandbox feeds update` and cached locally. Any package matched by a
        // feed ALWAYS blocks an install — feeds are an explicit team decision, not gated by
        // failOnAdvisory — and run with no network latency at install time (the cache is local).
        // OSV has publish lag; a second feed widens the net on the one check that matters most.
        malwareFeeds: z.array(z.string()).default([]),
        // Refuse to install a version the maintainer has DEPRECATED. A deprecated version is
        // abandoned — it won't get security fixes and is a standing supply-chain risk — so we
        // never resolve to one. On by default; `--allow-deprecated` overrides for one run. Rides
        // on riskHints (the same registry resolve), so `--risk off` also disables it.
        failOnDeprecated: z.boolean().default(true),
        // Persist the package manager's download cache in a named container volume across runs, so
        // repeated installs don't re-fetch every tarball — speed keeps people from routing around
        // the sandbox. Ergonomic, not a boundary: the install container is still throwaway; only
        // the integrity-checked cache survives. Set false for a fully cold, hermetic install.
        cache: z.boolean().default(true),
        // Plant CANARY honeytokens (fake AWS/Stripe/Slack credentials) in the install container's
        // environment and watch the egress proxy for them. The default-deny boundary blocks exfil;
        // canaries turn a blocked request into PROOF of intent — if a planted token shows up in the
        // proxy log, a script tried to steal credentials. Off by default (it's a tripwire, not a
        // boundary); only active in allowlist egress mode, where there's a proxy log to watch. A
        // canary hit fails the run unconditionally. None of the planted names are read by npm/pnpm/
        // yarn/bun, so this can't break a real install.
        canaries: z.boolean().default(false),
        // Tripwire for the writable source tree (the one surface NOT protected by default: a package
        // manager needs a writable root, so a malicious install CAN edit src/). When true, an install
        // that changes project files outside the dependency output and lockfiles FAILS the run, so CI or
        // an agent notices and reverts. Detection after the fact, not prevention: the edit still happened
        // (review with `git diff`). Off by default; the change is always reported + audited regardless.
        failOnSourceWrites: z.boolean().default(false),
        // Safe install by default: when `add`ing a package resolves to a freshly-published version
        // (inside the worm window), install the newest release that already predates the window and
        // pin it exact, instead of silently taking the fresh one. Your end goal is the install, so this
        // keeps it moving while closing the publish-and-detonate gap, and prints exactly what it did.
        // Only `add` (new deps); per-package `--allow-recent` (or this set false) takes the newest as
        // typed. A substituted version is always pinned exact so the choice is reproducible. Independent
        // of `riskHints`: `--risk off` silences the advisory report but does NOT disable this hold-back
        // (set this false to opt out). `--json`/`--dry-run` previews show the substituted plan, not the
        // version as typed, so a previewed plan matches the real run.
        safeInstall: z.boolean().default(true),
        // Also pin NON-substituted adds to an exact version (overriding the package manager's default
        // ^range). Off by default: forcing exact on every add overrides a range convention you may have
        // chosen deliberately. The safe substitution above is pinned exact regardless of this setting.
        pinExact: z.boolean().default(false),
      })
      .strict()
      .default({ network: 'allowlist', frozen: false, riskHints: 'basic', failOnRisk: false, minReleaseAgeDays: 0, minReleaseAgeExclude: [], failOnAdvisory: false, malwareFeeds: [], failOnDeprecated: true, cache: true, canaries: false, failOnSourceWrites: false, safeInstall: true, pinExact: false }),
    egress: z
      .object({ allow: z.array(z.string()).default(['npmjs.org', 'npmjs.com']) })
      .strict()
      .default({ allow: ['npmjs.org', 'npmjs.com'] }),
    run: z
      .object({
        network: NetworkMode.default('none'),
        ports: z.array(PortSpec).default([]),
        // Publish the common framework dev-server ports (Vite/Next/Astro/…) to the host
        // so `npm run dev` is reachable without listing each one. Only takes effect when
        // `network` isn't 'none'. The `vibe`/`agent` presets turn this on.
        devPorts: z.boolean().default(false),
      })
      .strict()
      .default({ network: 'none', ports: [], devPorts: false }),
    build: z
      // How the sandbox image is built. The bundled Dockerfile owns the security layers
      // (metadata guard, capability tooling, corepack); these knobs let a project pin the
      // base or layer extras on top WITHOUT replacing those layers. `customDockerfileUnsafe`
      // is the escape hatch that does replace them — and the only one that voids the boundary.
      .object({
        // Full `repo:tag[@digest]` for the image the Dockerfile builds FROM. Overrides nodeVersion.
        baseImage: z.string().optional(),
        // Convenience: build FROM `node:<nodeVersion>-bookworm-slim`. Ignored when baseImage is set.
        nodeVersion: z.string().optional(),
        // Extra apt packages installed on top of the security base.
        extraPackages: z.array(z.string()).default([]),
        // Extra raw Dockerfile instructions (RUN/ENV/COPY…) layered on top of the security base.
        // COPY/ADD paths resolve against your PROJECT ROOT (the build context), so they can pull
        // files from the repo into the image. Editing a COPY'd file won't auto-rebuild — run `sandbox build`.
        extraSteps: z.array(z.string()).default([]),
        // Replace the bundled Dockerfile entirely with this file. ADVANCED: the sandbox can no
        // longer guarantee its boundary (metadata guard, dropped caps, isolation) — you own it.
        // Named `…Unsafe` on purpose, warns loudly on every run, and a personal layer setting it
        // is always flagged. Prefer baseImage / extraPackages / extraSteps.
        customDockerfileUnsafe: z.string().optional(),
      })
      .strict()
      .default({ extraPackages: [], extraSteps: [] }),
  })
  .strict();

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export const SANDBOX_SCHEMA_REF = './node_modules/@jagreehal/sandbox-node/sandbox.schema.json';

/**
 * Strip JSONC comments (`// line` and `/* block *​/`) while preserving any `//`
 * that appears inside a string literal (e.g. a URL or path). This makes the
 * inline-comment manifest examples in the docs actually parse.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      inLine = true;
      i++;
    } else if (c === '/' && next === '*') {
      inBlock = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** Recursively drop `"//"`-prefixed keys (the JSON "note field" convention). */
function dropNoteKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNoteKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('//'))
        .map(([k, v]) => [k, dropNoteKeys(v)]),
    );
  }
  return value;
}

/** Where each config layer comes from, lowest precedence first. */
export type ConfigScope = 'user' | 'project' | 'local';

export interface LoadedConfig {
  config: SandboxConfig;
  /** Boundary fields a personal layer (user/local) loosened beyond the committed team config. */
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge raw config objects: objects merge recursively; arrays and scalars replace. */
function mergeRaw(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeRaw(prev, v) : v;
  }
  return out;
}

/**
 * Resolve a layer's relative `build.customDockerfileUnsafe` against the directory of the file
 * that DECLARED it — not the process cwd. A path written in `~/.config/sandbox-node/config.json`
 * or a `--config /elsewhere/sandbox.config.json` must mean "relative to that file", and survive
 * being run from any directory. Absolute paths pass through unchanged. Mutates the raw layer.
 */
function resolveLayerBuildPath(raw: Record<string, unknown>, layerDir: string): void {
  const build = raw.build;
  if (isPlainObject(build) && typeof build.customDockerfileUnsafe === 'string' && build.customDockerfileUnsafe) {
    build.customDockerfileUnsafe = path.resolve(layerDir, build.customDockerfileUnsafe);
  }
}

/** Read one config file as a raw object (JSONC + note-keys stripped). Missing file → undefined. */
function readRaw(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`sandbox: invalid JSON in ${file}: ${(e as Error).message}`);
  }
  const clean = dropNoteKeys(parsed);
  if (!isPlainObject(clean)) throw new Error(`sandbox: ${file} must contain a JSON object`);
  resolveLayerBuildPath(clean, path.dirname(file));
  return clean;
}

/** The per-user global config: `$XDG_CONFIG_HOME/sandbox-node/config.json` (or `~/.config/…`). */
export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'sandbox-node', 'config.json');
}

/** Filename of the personal, git-ignored override that sits beside a project config. */
export const LOCAL_CONFIG_NAME = 'sandbox.config.local.json';

/** Sibling personal override of a project config: `sandbox.config.local.json` (git-ignored). */
export function localConfigPath(projectFile: string): string {
  return path.join(path.dirname(projectFile), LOCAL_CONFIG_NAME);
}

/**
 * Flip the `off` escape hatch in the personal local override, preserving any other keys already
 * there. `sandbox off` / `sandbox on` write this so the toggle is one keystroke and never touches the
 * committed team config. Local layers win, so `on` (off:false) overrides even a committed `off:true`.
 * Returns the file written.
 */
export function setLocalOff(projectFile: string, off: boolean): string {
  const file = localConfigPath(projectFile);
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8'))) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  }
  writeFileSync(file, `${JSON.stringify({ ...existing, off }, null, 2)}\n`);
  return file;
}

function parseConfig(raw: Record<string, unknown>, label: string): SandboxConfig {
  const parsed = SandboxConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`sandbox: invalid config (${label}):\n${issues}`);
  }
  return parsed.data;
}

const NET_RANK: Record<NetworkMode, number> = { none: 0, allowlist: 1, on: 2 };
const CLAUDE_RANK = { none: 0, project: 1, home: 2 } as const;

/**
 * Warn when the effective config is LOOSER than the committed (team) baseline — i.e. a
 * personal layer (user-global or `*.local.json`) widened the boundary. Tightening is silent;
 * only loosening is flagged, because that's the un-reviewed change that matters for a sandbox.
 *
 * NOTE: the set of boundary fields lives here AND in `SandboxConfigSchema` — when you add a
 * security-relevant field to the schema, add its loosening check here too, or it won't be caught.
 */
function boundaryLooseningWarnings(eff: SandboxConfig, base: SandboxConfig): string[] {
  const w: string[] = [];
  const added = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  // The strongest loosening there is: a personal layer turning containment OFF entirely. Flag it
  // loudest, since every other boundary check below is moot once commands run on the host.
  if (eff.off && !base.off) w.push('containment DISABLED (off:true) by a personal layer, every command runs on the host with NO sandbox');
  if (NET_RANK[eff.install.network] > NET_RANK[base.install.network]) w.push(`install.network widened to '${eff.install.network}' (team config: '${base.install.network}')`);
  if (NET_RANK[eff.run.network] > NET_RANK[base.run.network]) w.push(`run.network widened to '${eff.run.network}' (team config: '${base.run.network}')`);
  const egress = added(eff.egress.allow, base.egress.allow);
  if (egress.length) w.push(`egress.allow added ${egress.join(', ')} beyond team config`);
  if (eff.grants['ssh-agent'] && !base.grants['ssh-agent']) w.push('grants.ssh-agent enabled beyond team config');
  if (CLAUDE_RANK[eff.grants.claude] > CLAUDE_RANK[base.grants.claude]) w.push(`grants.claude widened to '${eff.grants.claude}' (team config: '${base.grants.claude}')`);
  for (const key of ['paths', 'env', 'envFiles'] as const) {
    const extra = added(eff.grants[key], base.grants[key]);
    if (extra.length) w.push(`grants.${key} added ${extra.join(', ')} beyond team config`);
  }
  if (!eff.install.frozen && base.install.frozen) w.push('install.frozen disabled (team config requires reproducible installs)');
  for (const flag of ['failOnRisk', 'failOnAdvisory', 'failOnDeprecated', 'canaries'] as const) {
    if (!eff.install[flag] && base.install[flag]) w.push(`install.${flag} disabled beyond team config`);
  }
  if (eff.install.minReleaseAgeDays < base.install.minReleaseAgeDays) w.push(`install.minReleaseAgeDays lowered to ${eff.install.minReleaseAgeDays} (team config: ${base.install.minReleaseAgeDays})`);
  const droppedFeeds = base.install.malwareFeeds.filter((f) => !eff.install.malwareFeeds.includes(f));
  if (droppedFeeds.length) w.push(`install.malwareFeeds dropped ${droppedFeeds.join(', ')} (removed by a personal layer)`);
  if (eff.build.customDockerfileUnsafe && !base.build.customDockerfileUnsafe) w.push('build.customDockerfileUnsafe set by a personal layer, the sandbox boundary is no longer verified');
  return w;
}

/**
 * Load `sandbox.config.json` and its override layers, lowest precedence first:
 *
 *   1. user-global  `$XDG_CONFIG_HOME/sandbox-node/config.json`  (personal, cross-project)
 *   2. project/team `sandbox.config.json`                        (committed, reviewed)
 *   3. local        `sandbox.config.local.json`                  (personal, git-ignored)
 *
 * Layers are deep-merged as raw JSON then validated ONCE, so defaults apply to the composite
 * and unknown keys still surface as typos. A personal layer that loosens the boundary beyond
 * the committed config is reported in `warnings` (not blocked) — tighten freely, loosen loudly.
 */
export function loadConfig(cwd: string, configPath?: string): LoadedConfig {
  const projectFile = configPath ?? path.join(cwd, 'sandbox.config.json');
  const sources: { scope: ConfigScope; source: string }[] = [
    { scope: 'user', source: userConfigPath() },
    { scope: 'project', source: projectFile },
    { scope: 'local', source: localConfigPath(projectFile) },
  ];

  let merged: Record<string, unknown> = {};
  let committed: Record<string, unknown> = {}; // defaults + project only: the trusted baseline
  let hasPersonalLayer = false;
  for (const { scope, source } of sources) {
    const raw = readRaw(source);
    if (!raw) continue;
    merged = mergeRaw(merged, raw);
    if (scope === 'project') committed = mergeRaw(committed, raw);
    else hasPersonalLayer = true;
  }

  const config = parseConfig(merged, projectFile);
  const warnings = hasPersonalLayer ? boundaryLooseningWarnings(config, parseConfig(committed, projectFile)) : [];
  return { config, warnings };
}

/**
 * Load and validate the effective config (all layers merged). A missing file is valid —
 * every field has a safe default. Use {@link loadConfig} when you also need the layer
 * provenance or the boundary-loosening warnings.
 */
export function readConfig(cwd: string, configPath?: string): SandboxConfig {
  return loadConfig(cwd, configPath).config;
}

/**
 * The committed (team) baseline: schema defaults + the PROJECT layer ONLY — never the user-global
 * or `*.local.json` personal layers. Use this when WRITING back to the shared `sandbox.config.json`
 * (e.g. `sandbox allow`): writing the *merged* effective config would bake a teammate's personal
 * override (a loosened network, an extra grant) into the committed file. Reading project-only keeps
 * `allow` an additive edit to exactly what's already committed.
 */
export function readCommittedConfig(cwd: string, configPath?: string): SandboxConfig {
  const projectFile = configPath ?? path.join(cwd, 'sandbox.config.json');
  return parseConfig(readRaw(projectFile) ?? {}, projectFile);
}

/** Write a normalized config file with the shipped JSON Schema ref. */
export function writeConfig(file: string, config: SandboxConfig): string {
  writeFileSync(file, `${JSON.stringify({ $schema: SANDBOX_SCHEMA_REF, ...config }, null, 2)}\n`);
  return file;
}
