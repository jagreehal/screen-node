import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegistryClient } from './risk.js';

/**
 * "A new version is available" notice, the way npm/pnpm/etc. do it — but honest about being a
 * containment tool. The check is:
 *   - read-only from a small cache on disk (the banner NEVER blocks the current command), and
 *   - refreshed by a detached background process at most once a day, so the host→registry call is
 *     rare, off the hot path, and trivially disabled (NO_UPDATE_NOTIFIER / CI / --no-update-check).
 * First run sees nothing (empty cache) and kicks off the refresh; the next run shows the notice.
 */

export const PACKAGE_NAME = '@jagreehal/sandbox-node';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day, like update-notifier's default

interface CacheState {
  /** Epoch ms of the last refresh attempt — gates the once-a-day background check. */
  lastCheckMs: number;
  /** The `latest` dist-tag seen on the registry, or undefined before the first successful refresh. */
  latest?: string;
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'sandbox-node');
}

function cacheFile(): string {
  return path.join(cacheDir(), 'update-check.json');
}

function readCache(): CacheState {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Partial<CacheState>;
    return { lastCheckMs: typeof parsed.lastCheckMs === 'number' ? parsed.lastCheckMs : 0, latest: typeof parsed.latest === 'string' ? parsed.latest : undefined };
  } catch {
    return { lastCheckMs: 0 };
  }
}

function writeCache(state: CacheState): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(state));
  } catch {
    // best-effort cache: a read-only HOME just means no update notices, never a failed command
  }
}

/** True when `latest` is a strictly higher x.y.z than `current`. Prerelease/build metadata is ignored. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y) return x > y;
  }
  return false;
}

/** Env-level kill switches, honoured everywhere (CI, the common NO_UPDATE_NOTIFIER, and our own). */
export function disabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NO_UPDATE_NOTIFIER || env.CI || env.SANDBOX_NO_UPDATE_CHECK);
}

/** The boxed notice, or undefined when the cached `latest` is not newer than what's running. */
export function updateBanner(current: string, cache: CacheState = readCache()): string | undefined {
  if (!cache.latest || !isNewerVersion(cache.latest, current)) return undefined;
  const lines = [
    `Update available  ${current} → ${cache.latest}`,
    `Run  npm i -g ${PACKAGE_NAME}  to update`,
    `sandbox checked npm for this. disable: --no-update-check or NO_UPDATE_NOTIFIER=1`,
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const top = `┌${'─'.repeat(width + 2)}┐`;
  const bot = `└${'─'.repeat(width + 2)}┘`;
  const body = lines.map((l) => `│ ${l.padEnd(width)} │`).join('\n');
  return `\n${top}\n${body}\n${bot}\n`;
}

/**
 * Refresh the cache from the registry. Reuses {@link createRegistryClient} (same timeout +
 * `SANDBOX_NPM_REGISTRY` override as every other lookup), and swallows every failure — an offline
 * or rate-limited registry must never surface here. Runs in the detached child, not the main CLI.
 */
export async function refreshUpdateCache(client = createRegistryClient(), now: number = Date.now()): Promise<void> {
  try {
    const packument = (await client.getPackument(PACKAGE_NAME)) as unknown as { 'dist-tags'?: { latest?: unknown } };
    const latest = packument['dist-tags']?.latest;
    writeCache({ lastCheckMs: now, latest: typeof latest === 'string' ? latest : readCache().latest });
  } catch {
    // network/registry error — keep the old cache, just bump the timestamp so we back off for a day
    writeCache({ ...readCache(), lastCheckMs: now });
  }
}

/**
 * Spawn the daily background refresh (detached, no stdio) if the cache is stale. The timestamp is
 * bumped up-front so concurrent invocations don't each spawn a checker. `cliEntry` is the path to
 * this CLI's bin (process.argv[1]); the child re-enters it on the hidden `__update-check` command.
 */
export function scheduleUpdateCheck(cliEntry: string, now: number = Date.now()): void {
  const cache = readCache();
  if (now - cache.lastCheckMs < CHECK_INTERVAL_MS) return;
  writeCache({ ...cache, lastCheckMs: now });
  try {
    const child = spawn(process.execPath, [cliEntry, '__update-check'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // can't spawn (sandboxed/no exec) — skip silently; we already backed off via the timestamp
  }
}

/** The package's own version, read from the installed manifest next to the bundle. Undefined if unreadable. */
export function selfVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}
