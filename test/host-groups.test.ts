import { describe, expect, it } from 'vitest';
import { HOST_GROUPS, HOST_GROUP_NAMES, hostGroup } from '../src/host-groups.js';

describe('HOST_GROUPS', () => {
  it('exposes build-tools plus the narrow cloud groups, each with a non-empty host list and a why', () => {
    expect(HOST_GROUP_NAMES).toEqual(expect.arrayContaining(['build-tools', 'vercel', 'cloudflare', 'supabase', 'aws']));
    for (const g of HOST_GROUPS) {
      expect(g.hosts.length).toBeGreaterThan(0);
      expect(g.why.length).toBeGreaterThan(0);
    }
  });

  it('cloud groups are scoped to control-plane hosts, NO blanket object-storage wildcards', () => {
    const cloudHosts = HOST_GROUPS.filter((g) => g.name !== 'build-tools').flatMap((g) => g.hosts);
    // the exfil-sink wildcards we deliberately refuse to bundle
    expect(cloudHosts).not.toContain('amazonaws.com');
    expect(cloudHosts).not.toContain('vercel.app');
    expect(cloudHosts).not.toContain('r2.cloudflarestorage.com');
    // AWS is auth-only
    expect(hostGroup('aws')?.hosts).toEqual(['sts.amazonaws.com']);
    expect(hostGroup('vercel')?.hosts).toEqual(['api.vercel.com']);
  });

  it('build-tools carries the native-build bundle, never a registry', () => {
    const bt = hostGroup('build-tools')!;
    expect(bt.hosts).toContain('nodejs.org');
    expect(bt.hosts).not.toContain('npmjs.org');
  });
});
