import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '../src/config.js';
import { BASE_IMAGE, CLAUDE_DOMAINS, devcontainerDockerfile, devcontainerJson, firewallAllowlist, firewallEnabled, initFirewallScript, writeDevcontainer } from '../src/devcontainer.js';
import { presetConfig } from '../src/presets.js';

const balanced = presetConfig('balanced');
const vibe = presetConfig('vibe');
const trusted = presetConfig('trusted');

describe('firewallEnabled', () => {
  it('is on when either phase uses an allowlist', () => {
    expect(firewallEnabled(balanced)).toBe(true); // install defaults to allowlist
    expect(firewallEnabled(vibe)).toBe(true);
  });

  it('is off when config grants full network (trusted)', () => {
    expect(firewallEnabled(trusted)).toBe(false);
  });
});

describe('firewallAllowlist', () => {
  it('unions the user egress.allow with the domains Claude itself needs', () => {
    const config = SandboxConfigSchema.parse({ egress: { allow: ['npmjs.org', 'example.com'] } });
    const list = firewallAllowlist(config);
    expect(list).toContain('example.com');
    expect(list).toContain('npmjs.org');
    for (const d of CLAUDE_DOMAINS) expect(list).toContain(d);
  });

  it('dedupes overlap between egress.allow and Claude domains', () => {
    const config = SandboxConfigSchema.parse({ egress: { allow: ['github.com'] } });
    const list = firewallAllowlist(config);
    expect(list.filter((d) => d === 'github.com')).toHaveLength(1);
  });
});

describe('devcontainerJson', () => {
  it('runs the agent as non-root so --dangerously-skip-permissions is accepted', () => {
    expect(devcontainerJson(balanced, 'pnpm').remoteUser).toBe('node');
  });

  it('installs Claude Code via the official feature and persists ~/.claude', () => {
    const json = devcontainerJson(balanced, 'pnpm');
    expect(Object.keys(json.features as object)[0]).toContain('anthropics/devcontainer-features/claude-code');
    expect((json.mounts as string[])[0]).toContain('/home/node/.claude');
  });

  it('mounts node_modules as a named volume so the host never sees the container tree', () => {
    const json = devcontainerJson(balanced, 'pnpm');
    const nm = (json.mounts as string[]).find((m) => m.includes('/node_modules'));
    expect(nm).toBeDefined();
    expect(nm).toContain('type=volume');
    // Targets the container workspace's node_modules, with a per-project (basename-keyed) volume name.
    expect(nm).toContain('target=${containerWorkspaceFolder}/node_modules');
    expect(nm).toContain('source=${localWorkspaceFolderBasename}-');
  });

  it('populates the volume on create with the project PM, chowning first (named volumes mount as root)', () => {
    expect(devcontainerJson(balanced, 'pnpm').postCreateCommand).toContain('sudo chown node:node node_modules');
    // pnpm/yarn go through Corepack so a host with no global shim still installs.
    expect(devcontainerJson(balanced, 'pnpm').postCreateCommand).toContain('corepack pnpm install');
    expect(devcontainerJson(balanced, 'npm').postCreateCommand).toContain('npm install');
    expect(devcontainerJson(balanced, 'bun').postCreateCommand).toContain('bun install');
  });

  it('grants firewall capabilities + a postStart hook when egress is restricted', () => {
    const json = devcontainerJson(balanced, 'pnpm');
    expect(json.runArgs).toEqual(['--cap-add=NET_ADMIN', '--cap-add=NET_RAW']);
    expect(json.postStartCommand).toContain('init-firewall.sh');
  });

  it('runs the firewall BEFORE the create-time install so that install is itself contained', () => {
    const cmd = devcontainerJson(balanced, 'pnpm').postCreateCommand as string;
    expect(cmd.indexOf('init-firewall.sh')).toBeLessThan(cmd.indexOf('corepack pnpm install'));
  });

  it('omits the firewall wiring for full-network (trusted) configs', () => {
    const json = devcontainerJson(trusted, 'pnpm');
    expect(json.runArgs).toBeUndefined();
    expect(json.postStartCommand).toBeUndefined();
    // Still installs on create, just without the firewall prefix.
    expect(json.postCreateCommand).not.toContain('init-firewall.sh');
    expect(json.postCreateCommand).toContain('install');
  });

  it('forwards configured + dev-server ports for vibe', () => {
    expect(devcontainerJson(vibe, 'pnpm').forwardPorts).toContain(5173);
  });
});

describe('devcontainerDockerfile pinning', () => {
  const digestRef = `${BASE_IMAGE}@sha256:${'a'.repeat(64)}`;

  it('pins FROM to the resolved digest and annotates it for Renovate', () => {
    const dockerfile = devcontainerDockerfile(balanced, { baseImage: digestRef });
    expect(dockerfile).toContain(`FROM ${digestRef}`);
    expect(dockerfile).toContain('# renovate: datasource=docker depName=mcr.microsoft.com/devcontainers/javascript-node');
  });

  it('falls back to the tag (still annotated) when no digest is given', () => {
    const dockerfile = devcontainerDockerfile(balanced);
    expect(dockerfile).toContain(`FROM ${BASE_IMAGE}`);
    expect(dockerfile).not.toContain('@sha256:');
    expect(dockerfile).toContain('# renovate:');
  });

  it('writeDevcontainer reports whether the base image was pinned', () => {
    const dir1 = mkdtempSync(path.join(tmpdir(), 'sbx-pin-'));
    expect(writeDevcontainer(dir1, balanced, { baseImage: digestRef }).pinned).toBe(true);
    const dir2 = mkdtempSync(path.join(tmpdir(), 'sbx-nopin-'));
    expect(writeDevcontainer(dir2, balanced).pinned).toBe(false);
  });
});

describe('initFirewallScript', () => {
  it('lists every allowed domain and self-tests a blocked one', () => {
    const config = SandboxConfigSchema.parse({ egress: { allow: ['npmjs.org'] } });
    const script = initFirewallScript(config);
    expect(script).toContain('"api.anthropic.com"');
    expect(script).toContain('"npmjs.org"');
    expect(script).toContain('example.com'); // the self-test target that must be blocked
    expect(script).toContain('iptables -P OUTPUT DROP');
  });
});

describe('writeDevcontainer', () => {
  it('writes devcontainer.json + Dockerfile + firewall, and refuses to clobber', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-dc-'));
    const result = writeDevcontainer(dir, balanced);
    expect(result.firewall).toBe(true);
    expect(existsSync(path.join(dir, '.devcontainer/devcontainer.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.devcontainer/Dockerfile'))).toBe(true);
    expect(existsSync(path.join(dir, '.devcontainer/init-firewall.sh'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, '.devcontainer/devcontainer.json'), 'utf8')).name).toBe('sandbox-node');

    expect(() => writeDevcontainer(dir, balanced)).toThrow(/already exists/);
    expect(() => writeDevcontainer(dir, balanced, { force: true })).not.toThrow();
  });

  it('skips the firewall file for full-network configs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-dc-tr-'));
    const result = writeDevcontainer(dir, trusted);
    expect(result.firewall).toBe(false);
    expect(existsSync(path.join(dir, '.devcontainer/init-firewall.sh'))).toBe(false);
  });
});
