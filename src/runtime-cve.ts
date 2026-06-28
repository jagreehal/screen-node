/**
 * A container-runtime escape a malicious install could leverage. If a postinstall can
 * break out of the container, every other guarantee here is moot — so a stale runtime
 * is worth surfacing in `doctor`.
 */
export interface RuntimeVuln {
  /** CVE identifier. */
  id: string;
  /** Short human name. */
  name: string;
  /** What the bug lets an attacker do. */
  detail: string;
  /** How to remediate. */
  fix: string;
}

type Version = [number, number, number];

/** Parse the first dotted version in a string (`1.1.12`, `v1.1.12`, `24.0.9-ce`, `Docker version 25.0.2, build …`). */
export function parseVersion(raw: string | undefined): Version | undefined {
  if (!raw) return undefined;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

const LEAKY_VESSELS: RuntimeVuln = {
  id: 'CVE-2024-21626',
  name: 'Leaky Vessels',
  detail: "a runc working-directory / file-descriptor leak lets a crafted image or process escape to the host filesystem",
  fix: 'upgrade to runc ≥ 1.1.12 (Docker Engine ≥ 25.0.2, or ≥ 24.0.9 on the 24.x line)',
};

const RUNC_EXE_OVERWRITE: RuntimeVuln = {
  id: 'CVE-2019-5736',
  name: 'runc /proc/self/exe overwrite',
  detail: 'a container process can overwrite the host runc binary and gain root code execution on the host',
  fix: 'upgrade runc to ≥ 1.0.0-rc6 (any currently-maintained Docker/Podman)',
};

/**
 * Node.js release end-of-life dates by MAJOR version. The runtime that executes a malicious install
 * lives inside the sandbox image, so an EOL Node line there means lifecycle scripts run on a runtime
 * that no longer gets security fixes — worth a `doctor` nudge. STATIC TABLE: it needs a periodic bump
 * as the release schedule advances (odd majors are short-lived and intentionally omitted — treated as
 * unknown). Dates from the Node.js release schedule.
 */
const NODE_EOL: Record<number, string> = {
  16: '2023-09-11',
  18: '2025-04-30',
  20: '2026-04-30',
  22: '2027-04-30',
  24: '2028-04-30',
};

export interface NodeEolStatus {
  major: number;
  /** 'eol' = past end-of-life; 'active' = still maintained; 'unknown' = not in the table (e.g. odd/pre-release major). */
  status: 'eol' | 'active' | 'unknown';
  /** EOL date (ISO) when known. */
  eol?: string;
}

/** Classify a Node major against the EOL table. `now` defaults to the current date. */
export function nodeEolStatus(major: number, now: Date = new Date()): NodeEolStatus {
  const eol = NODE_EOL[major];
  if (!eol) return { major, status: 'unknown' };
  return { major, status: now.getTime() > new Date(`${eol}T23:59:59Z`).getTime() ? 'eol' : 'active', eol };
}

/**
 * Assess known container-escape CVEs. Prefers the runc version when it's a real
 * semver; otherwise (e.g. `docker info` reports a commit hash) falls back to the
 * Docker engine version, which bundles a known runc. Engine-version mapping is
 * Docker-specific — pass `runc` only for non-Docker runtimes so it isn't misread.
 */
export function runtimeVulnerabilities(input: { engine?: string; runc?: string }): RuntimeVuln[] {
  const out: RuntimeVuln[] = [];
  const runc = parseVersion(input.runc);
  const engine = parseVersion(input.engine);

  if (runc) {
    if (cmp(runc, [1, 1, 12]) < 0) out.push(LEAKY_VESSELS);
    if (cmp(runc, [1, 0, 0]) < 0) out.push(RUNC_EXE_OVERWRITE);
  } else if (engine) {
    // Leaky Vessels was fixed in Docker Engine 25.0.2 and backported to 24.0.9.
    const patched = cmp(engine, [25, 0, 2]) >= 0 || (cmp(engine, [24, 0, 9]) >= 0 && cmp(engine, [25, 0, 0]) < 0);
    if (!patched) out.push(LEAKY_VESSELS);
  }
  return out;
}
