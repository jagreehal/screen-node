// `sandbox upgrade` — move declared dependency RANGES to newer versions (the npm-check-updates job),
// not just within the existing range (that's `sandbox npm update`). The whole point is to do it
// SAFELY: ncu's --cooldown is the same control as the sandbox's release-age gate, so this drives ncu
// from screen.config.json instead of asking the user to re-type --cooldown. ncu only reads/writes
// package.json and queries registry metadata — it never runs package code — so it runs on the host;
// the actual install that materialises the change still goes through the jailed install path.
//
// This module owns the pure pieces (flag mapping, parsing, classification, table rendering) plus one
// injectable runner seam, mirroring the rest of the codebase: the CLI shell decides what to print,
// what blocks, and when to write.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PackageManager } from './package-manager.js';
import type { RiskTarget } from './risk.js';

/** Which version ncu may move a range to. Mirrors ncu's `--target`. */
export type UpgradeTarget = 'latest' | 'minor' | 'patch' | 'newest' | 'greatest' | 'semver';

export interface UpgradePolicy {
  /** Minimum publish age before a version is eligible — maps to ncu `--cooldown Nd`. 0 = off. */
  cooldownDays: number;
  /** How far ncu may move a range. */
  target: UpgradeTarget;
  /** Package-name patterns ncu must not touch at all — maps to ncu `--reject`. */
  reject: string[];
  /** Restrict the run to only these name patterns — maps to ncu `--filter`. Empty = all. */
  filter: string[];
}

/** package.json's four dependency blocks, in the order we read/write them. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * The ncu version the host runs, pinned so a supply-chain tool never shells out to a floating
 * `latest`. Overridable for users who must run a different line. Bumping this is a deliberate edit.
 */
export const NCU_SPEC = process.env.SCREEN_NCU_SPEC || 'npm-check-updates@22';

/**
 * Build the ncu argv (without the runner prefix). ncu is used for DISCOVERY only — always a
 * machine-readable preview (`--jsonUpgraded`); the actual write is done by {@link applyUpgrades} so
 * what gets written is exactly what the gates approved. `--cooldown` is added only when a release-age
 * threshold is active. `--filter`/`--reject` take a single space-delimited value (ncu's own format),
 * so patterns are joined rather than repeated.
 */
export function ncuArgv(policy: UpgradePolicy, pm: PackageManager): string[] {
  const argv = ['--packageManager', pm];
  if (policy.cooldownDays > 0) argv.push('--cooldown', `${policy.cooldownDays}d`);
  if (policy.target !== 'latest') argv.push('--target', policy.target); // latest is ncu's default
  if (policy.filter.length) argv.push('--filter', policy.filter.join(' '));
  if (policy.reject.length) argv.push('--reject', policy.reject.join(' '));
  argv.push('--jsonUpgraded');
  return argv;
}

/**
 * The one or two ncu passes that honor a per-package cooldown exemption. ncu's `--cooldown` is global,
 * so `minReleaseAgeExclude` / `--allow-recent` packages can't be "allowed to be newer" in a single
 * run. When both a cooldown and exemptions are active we split into:
 *   1. a gated pass — cooldown on, the exempt patterns `--reject`ed out, and
 *   2. an exempt pass — no cooldown, `--filter`ed to ONLY the exempt patterns.
 * Their proposal sets are disjoint by construction, so merging is a plain union. With no cooldown or
 * no exemptions there's nothing to split, so it stays a single pass (no extra ncu call).
 */
export function ncuPasses(policy: UpgradePolicy, exempt: string[], pm: PackageManager): string[][] {
  if (policy.cooldownDays > 0 && exempt.length) {
    return [
      ncuArgv({ ...policy, reject: [...policy.reject, ...exempt], filter: [] }, pm),
      ncuArgv({ cooldownDays: 0, target: policy.target, reject: policy.reject, filter: exempt }, pm),
    ];
  }
  return [ncuArgv(policy, pm)];
}

export interface ProposedUpgrade {
  name: string;
  /** Declared range today, e.g. `^4.17.0` (or `-` when ncu names a dep we can't find declared). */
  from: string;
  /** Range ncu would write, e.g. `^4.18.0`. */
  to: string;
}

/** Strip a range operator so a gate can resolve a concrete version: `^4.18.0` → `4.18.0`. */
export function rangeToVersion(range: string): string {
  return range.replace(/^[\s^~>=<v]*/, '').trim();
}

/**
 * Parse ncu `--jsonUpgraded` output (a flat `{ name: toRange }` map) into proposals, pairing each with
 * the range currently declared in package.json. Returns `[]` on unparseable output (ncu prints `{}`
 * when nothing is upgradable, which parses to an empty list naturally).
 */
export function parseUpgrades(json: string, current: Record<string, string>): ProposedUpgrade[] {
  let map: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return [];
    map = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  return Object.entries(map)
    .filter(([, to]) => typeof to === 'string')
    .map(([name, to]) => ({ name, from: current[name] ?? '-', to: to as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Union the proposals from each ncu pass, de-duplicated by name (first wins), sorted. */
export function mergeProposals(lists: ProposedUpgrade[][]): ProposedUpgrade[] {
  const byName = new Map<string, ProposedUpgrade>();
  for (const list of lists) {
    for (const u of list) if (!byName.has(u.name)) byName.set(u.name, u);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The `name@version` set a gate must vet — ncu's proposed target versions, range-stripped. */
export function upgradeTargets(upgrades: ProposedUpgrade[]): RiskTarget[] {
  return upgrades.map((u) => ({ name: u.name, spec: rangeToVersion(u.to) }));
}

/** Every declared dependency range across all four dependency fields of package.json. */
export function readDeclaredRanges(cwd: string): Record<string, string> {
  let pj: Record<string, unknown>;
  try {
    pj = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const f of DEP_FIELDS) {
    const block = pj[f];
    if (block && typeof block === 'object') {
      for (const [name, range] of Object.entries(block as Record<string, unknown>)) {
        if (typeof range === 'string') out[name] = range;
      }
    }
  }
  return out;
}

/** The indentation a package.json uses, so a rewrite matches it (npm's own default is two spaces). */
function detectIndent(text: string): string | number {
  const ws = text.match(/\n([ \t]+)"/)?.[1];
  if (!ws) return 2;
  return ws.includes('\t') ? '\t' : ws.length;
}

/**
 * Apply the gated proposals to package.json text and return the new text. This — not `ncu -u` — is
 * what writes, so the bytes that land are exactly the versions the gates approved (no re-resolve, no
 * window for a newer publish to slip in between preview and write). Each dep is updated in whichever
 * field declares it; indentation is preserved and a trailing newline is ensured.
 */
export function applyUpgrades(pkgText: string, upgrades: ProposedUpgrade[]): string {
  const pkg = JSON.parse(pkgText) as Record<string, unknown>;
  const toByName = new Map(upgrades.map((u) => [u.name, u.to]));
  for (const field of DEP_FIELDS) {
    const block = pkg[field];
    if (block && typeof block === 'object') {
      for (const name of Object.keys(block as Record<string, unknown>)) {
        const to = toByName.get(name);
        if (to !== undefined) (block as Record<string, string>)[name] = to;
      }
    }
  }
  return `${JSON.stringify(pkg, null, detectIndent(pkgText))}\n`;
}

/** Which gate, if any, a proposed upgrade trips. `ok` means it passed every active gate. */
export type UpgradeGate = 'ok' | 'age' | 'malware' | 'deprecated';

export interface ClassifiedUpgrade extends ProposedUpgrade {
  gate: UpgradeGate;
}

/** Names flagged by each gate, so classification stays free of the PreflightResult shape. */
export interface GateFlags {
  ageNames: Set<string>;
  malwareNames: Set<string>;
  deprecatedNames: Set<string>;
}

/**
 * Tag each proposal with the worst gate it trips. Precedence matches the install gate: malware is the
 * hardest stop, then deprecated, then too-new (age). A clean proposal is `ok`.
 */
export function classifyUpgrades(upgrades: ProposedUpgrade[], flags: GateFlags): ClassifiedUpgrade[] {
  return upgrades.map((u) => {
    const gate: UpgradeGate = flags.malwareNames.has(u.name)
      ? 'malware'
      : flags.deprecatedNames.has(u.name)
        ? 'deprecated'
        : flags.ageNames.has(u.name)
          ? 'age'
          : 'ok';
    return { ...u, gate };
  });
}

const GATE_BADGE: Record<UpgradeGate, string> = {
  ok: '',
  age: '⚠ too new',
  malware: '✖ MALWARE',
  deprecated: '✖ deprecated',
};

/** A left-aligned, padded table: `name  from → to  [badge]`. Pure; the CLI adds the surrounding log. */
export function renderUpgradeTable(rows: ClassifiedUpgrade[]): string {
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const fromW = Math.max(...rows.map((r) => r.from.length));
  return rows
    .map((r) => {
      const badge = GATE_BADGE[r.gate];
      const line = `  ${r.name.padEnd(nameW)}  ${r.from.padStart(fromW)} → ${r.to}`;
      return badge ? `${line.padEnd(nameW + fromW + 12)}  ${badge}` : line;
    })
    .join('\n');
}

/** A run of ncu: its stdout (parsed by the caller) and exit code. */
export interface NcuRun {
  stdout: string;
  code: number;
}

/** The seam the CLI calls to run ncu — injected as a fake in tests. */
export type NcuRunner = (argv: string[], cwd: string) => NcuRun;

/**
 * Default runner: invoke the pinned ncu via `npx --yes` on the host for DISCOVERY (the
 * `--jsonUpgraded` report). Its diagnostics go to the inherited stderr so a network/registry failure
 * is visible. A non-zero exit with no stdout means ncu couldn't run; the caller surfaces that rather
 * than silently treating it as "nothing to upgrade".
 */
export function defaultNcuRunner(): NcuRunner {
  return (argv, cwd) => {
    try {
      const stdout = execFileSync('npx', ['--yes', NCU_SPEC, ...argv], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      return { stdout, code: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer | string; status?: number };
      return { stdout: err.stdout?.toString() ?? '', code: typeof err.status === 'number' ? err.status : 1 };
    }
  };
}
