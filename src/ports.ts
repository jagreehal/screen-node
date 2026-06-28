import { createServer } from 'node:net';

/**
 * Port publishing, made truthful and conflict-safe.
 *
 * Two failure modes this module exists to kill:
 *  1. A bare `"4321"` in `run.ports` becomes `docker run -p 4321`, which publishes the
 *     container port to a RANDOM host port — while the CLI confidently prints "4321". We
 *     normalise every spec to an explicit `HOST:CONTAINER` so the mapping is deterministic
 *     and the message can't lie.
 *  2. Publishing a fixed set (the common dev ports) hard-fails the whole run when one host
 *     port is already taken (`Bind for 0.0.0.0:8080 failed: port is already allocated`). We
 *     probe host availability first and skip the busy ones with a clear notice instead.
 */

/** A parsed publish spec. `ip` is present only for the `IP:HOST:CONTAINER` form. */
export interface ParsedPort {
  ip?: string;
  host: number;
  container: number;
}

/** A reachable endpoint, for human messaging and machine-readable (`--json`) output alike. */
export interface PortEndpoint {
  container: number;
  host: number;
  url: string;
}

const PORT_FORMS = 'use "PORT" (e.g. "4321"), "HOST:CONTAINER" (e.g. "3000:3000"), or "IP:HOST:CONTAINER"';

function asPortNumber(value: string, spec: string | number): number {
  if (!/^\d+$/.test(value)) throw new Error(`sandbox: invalid port "${spec}", ${PORT_FORMS}`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`sandbox: invalid port "${spec}", ${n} is out of range (1–65535)`);
  return n;
}

/**
 * Parse a publish spec into `{ ip?, host, container }`. Accepts a bare number/string port
 * (host == container), `HOST:CONTAINER`, or `IP:HOST:CONTAINER`. Throws with the accepted
 * forms on anything else.
 */
export function parsePortSpec(spec: string | number): ParsedPort {
  if (typeof spec === 'number') {
    const port = asPortNumber(String(spec), spec);
    return { host: port, container: port };
  }
  const parts = spec.trim().split(':');
  if (parts.length === 1) {
    const port = asPortNumber(parts[0]!, spec);
    return { host: port, container: port };
  }
  if (parts.length === 2) {
    return { host: asPortNumber(parts[0]!, spec), container: asPortNumber(parts[1]!, spec) };
  }
  if (parts.length === 3) {
    const ip = parts[0]!;
    if (ip === '') throw new Error(`sandbox: invalid port "${spec}", ${PORT_FORMS}`);
    return { ip, host: asPortNumber(parts[1]!, spec), container: asPortNumber(parts[2]!, spec) };
  }
  throw new Error(`sandbox: invalid port "${spec}", ${PORT_FORMS}`);
}

/** True when a spec parses; used by the config schema's `.refine` for a friendly error. */
export function isValidPortSpec(spec: string | number): boolean {
  try {
    parsePortSpec(spec);
    return true;
  } catch {
    return false;
  }
}

/** Canonical `HOST:CONTAINER` (or `IP:HOST:CONTAINER`) string for a spec — never a bare port. */
export function normalizePort(spec: string | number): string {
  const { ip, host, container } = parsePortSpec(spec);
  return ip ? `${ip}:${host}:${container}` : `${host}:${container}`;
}

/** The host port a spec publishes on (accepts a raw config value or a normalised string). */
export function hostPortOf(spec: string | number): number {
  return parsePortSpec(spec).host;
}

/** The interface a spec binds on: its explicit IP, or all interfaces. */
function bindAddress(p: ParsedPort): string {
  return p.ip ?? '0.0.0.0';
}

/** Identity of a host endpoint — two specs sharing it can't both publish (Docker binds it once). */
function bindKey(p: ParsedPort): string {
  return `${bindAddress(p)}:${p.host}`;
}

/** Endpoints for a set of normalised specs — what to open in a browser, in order. */
export function endpointsFor(specs: string[]): PortEndpoint[] {
  return specs.map((spec) => {
    const { ip, host, container } = parsePortSpec(spec);
    return { container, host, url: `http://${ip ?? 'localhost'}:${host}` };
  });
}

/**
 * Probe a host TCP endpoint by trying to bind it. Resolves true when free, false when in use
 * (`EADDRINUSE`) or otherwise unbindable (e.g. an IP that isn't a host interface — Docker
 * couldn't bind it either). Best-effort: a TOCTOU race with the real publish is possible but
 * rare, and a genuine bind failure still surfaces from the container runtime.
 */
export function isHostPortFree(port: number, address = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, address);
  });
}

export interface ResolvedPorts {
  /** Specs whose host endpoint is free — safe to publish. */
  available: string[];
  /** Specs skipped because the host endpoint is already in use. */
  busy: string[];
  /** Specs dropped because an earlier spec already claims the same host endpoint (config collision). */
  conflicts: string[];
}

/**
 * Partition normalised specs into the ones we can publish, the ones whose host endpoint is
 * taken, and duplicate specs that collide on the same host endpoint. Pure but for the injected
 * `isFree` probe, so it's exercised directly in tests. Identity is `IP:HOST` (not the host port
 * alone), so `127.0.0.1:3000:3000` and `192.168.1.10:3000:3000` are distinct publishes rather
 * than one silently swallowing the other. The survivors are probed in parallel (independent
 * checks); first-seen order is preserved across all three buckets.
 */
export async function resolvePortPublish(specs: string[], isFree: (port: number, address: string) => Promise<boolean>): Promise<ResolvedPorts> {
  const claimed = new Set<string>();
  const conflicts: string[] = [];
  const unique = specs.filter((spec) => {
    const key = bindKey(parsePortSpec(spec));
    if (claimed.has(key)) {
      conflicts.push(spec);
      return false;
    }
    claimed.add(key);
    return true;
  });
  const parsed = unique.map(parsePortSpec);
  const free = await Promise.all(parsed.map((p) => isFree(p.host, bindAddress(p))));
  const available: string[] = [];
  const busy: string[] = [];
  unique.forEach((spec, i) => (free[i] ? available : busy).push(spec));
  return { available, busy, conflicts };
}
