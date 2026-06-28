import type { NetworkMode } from './config.js';

/**
 * What a {@link NetworkMode} means, in one table. The meaning of `none`/`on`/
 * `allowlist` used to be smeared across the planner (host-gateway, port publishing)
 * and the executor (proxy stand-up, `--network none`); decode it here once so the
 * two halves can't disagree.
 */
export interface NetworkPolicy {
  /** Run with `--network none` — no network interface at all. */
  isolate: boolean;
  /** Add `host.docker.internal:host-gateway` so the container can reach host services. */
  hostGateway: boolean;
  /** Publish the configured ports to the host. */
  publishPorts: boolean;
  /** Stand up the egress proxy and route the container through it (default-deny allowlist). */
  useEgressProxy: boolean;
}

/**
 * Dev-server ports we publish when `run.devPorts` is on — covers Vite (5173) + its
 * preview (4173), Next/Remix/Nuxt/CRA (3000), Astro (4321), Angular (4200), and the
 * generic webpack/vue port (8080). Whichever one the framework picks is already mapped.
 */
export const COMMON_DEV_PORTS = [3000, 4173, 4200, 4321, 5173, 8080];

/** Decode a network mode into the concrete switches the plan and executor act on. */
export function networkPolicy(mode: NetworkMode): NetworkPolicy {
  switch (mode) {
    case 'none':
      return { isolate: true, hostGateway: false, publishPorts: false, useEgressProxy: false };
    case 'on':
      return { isolate: false, hostGateway: true, publishPorts: true, useEgressProxy: false };
    case 'allowlist':
      return { isolate: false, hostGateway: false, publishPorts: true, useEgressProxy: true };
  }
}
