import { describe, expect, it } from 'vitest';
import type { NetworkMode } from '../src/config.js';
import { networkPolicy, type NetworkPolicy } from '../src/network.js';

describe('networkPolicy', () => {
  const TABLE: Record<NetworkMode, NetworkPolicy> = {
    none: { isolate: true, hostGateway: false, publishPorts: false, useEgressProxy: false },
    on: { isolate: false, hostGateway: true, publishPorts: true, useEgressProxy: false },
    allowlist: { isolate: false, hostGateway: false, publishPorts: true, useEgressProxy: true },
  };

  it.each(Object.entries(TABLE) as [NetworkMode, NetworkPolicy][])('decodes %s into the expected switches', (mode, expected) => {
    expect(networkPolicy(mode)).toEqual(expected);
  });

  it('only allowlist stands up the egress proxy', () => {
    expect(networkPolicy('allowlist').useEgressProxy).toBe(true);
    expect(networkPolicy('on').useEgressProxy).toBe(false);
    expect(networkPolicy('none').useEgressProxy).toBe(false);
  });

  it('only none fully isolates the container', () => {
    expect(networkPolicy('none').isolate).toBe(true);
    expect(networkPolicy('on').isolate).toBe(false);
    expect(networkPolicy('allowlist').isolate).toBe(false);
  });

  it('only on wires host.docker.internal', () => {
    expect(networkPolicy('on').hostGateway).toBe(true);
    expect(networkPolicy('none').hostGateway).toBe(false);
    expect(networkPolicy('allowlist').hostGateway).toBe(false);
  });
});
