import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SandboxConfig } from './config.js';
import { capture } from './exec.js';
import { COMMON_DEV_PORTS } from './network.js';
import { hostPortOf } from './ports.js';
import { pmArgv, resolvePackageManager, type PackageManager } from './package-manager.js';

/** Base image for the generated devcontainer (repo:tag; the digest is resolved at init time). */
export const BASE_IMAGE = 'mcr.microsoft.com/devcontainers/javascript-node:24-bookworm';

/**
 * Resolve `repo:tag` to its registry digest so the Dockerfile can pin `FROM …@sha256:…`
 * (a generated devcontainer should be at least as strict as a hand-rolled one). Returns
 * `null` when the runtime can't reach the registry — the caller then emits the tag alone,
 * still annotated for Renovate so the first online run pins it.
 */
export async function resolveImageDigest(bin: string, ref: string): Promise<string | null> {
  const { code, stdout } = await capture(bin, ['buildx', 'imagetools', 'inspect', ref, '--format', '{{.Manifest.Digest}}']);
  if (code !== 0) return null;
  const digest = stdout.trim();
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/**
 * Generate a hardened `.devcontainer/` from the SAME `sandbox.config.json` that drives the
 * ephemeral `sandbox npm install` path.
 *
 * The two are one policy at two lifecycles:
 *   - ephemeral (per-operation): agent/editor on the host, each dangerous op jailed.
 *   - persistent (per-session): agent/editor INSIDE the jail; this generator emits it.
 *
 * Because both read the same config, the persistent mode inherits the ephemeral mode's
 * hardening — default-deny egress (the same `egress.allow`), non-root user, and the
 * agent-enforcement hook. The rule once you're in here: run plain `npm install`, NOT
 * `sandbox npm install` — the whole environment already *is* the sandbox, and nesting a
 * second container would need the Docker socket (host root), defeating the point.
 */

/**
 * Domains Claude Code itself needs when it runs *inside* the container (inference, auth,
 * and its own distribution/update channel). The ephemeral model never needs these because
 * the agent stays on the host; the persistent model does, so they're added to the firewall
 * allowlist on top of the user's `egress.allow`.
 */
export const CLAUDE_DOMAINS = [
  'api.anthropic.com',
  'claude.ai',
  'console.anthropic.com',
  'registry.npmjs.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

/** Whether the session should run behind the egress firewall, derived from config. */
export function firewallEnabled(config: SandboxConfig): boolean {
  // If either phase is locked to an allowlist, the persistent session keeps that posture.
  // `trusted`/full-network configs opt out (no allowlist to enforce).
  return config.install.network === 'allowlist' || config.run.network === 'allowlist';
}

/** Apex domains the in-container firewall permits: the user's allowlist + Claude's own. */
export function firewallAllowlist(config: SandboxConfig): string[] {
  return [...new Set([...config.egress.allow, ...CLAUDE_DOMAINS])].sort();
}

/** Host ports to forward to the editor: the configured maps plus the dev-server set. */
function forwardPorts(config: SandboxConfig): number[] {
  const fromMaps = config.run.ports.map(hostPortOf);
  const dev = config.run.devPorts ? COMMON_DEV_PORTS : [];
  return [...new Set([...fromMaps, ...dev])].sort((a, b) => a - b);
}

/** The generated `devcontainer.json` as a plain object (pure; the writer serializes it). */
export function devcontainerJson(config: SandboxConfig, pm: PackageManager): Record<string, unknown> {
  const firewall = firewallEnabled(config);
  const json: Record<string, unknown> = {
    $schema: 'https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainer.schema.json',
    name: 'sandbox-node',
    build: { dockerfile: 'Dockerfile' },
    // Non-root so `--dangerously-skip-permissions` is accepted and bind-mounted files
    // aren't written as root. The base image ships a `node` user with passwordless sudo.
    remoteUser: 'node',
    // Claude Code installed by the official feature; auto-updates inside the container.
    features: {
      'ghcr.io/anthropics/devcontainer-features/claude-code:1.0': {},
    },
    mounts: [
      // Persist Claude auth/settings/history across rebuilds, isolated per devcontainer.
      'source=sandbox-claude-config-${devcontainerId},target=/home/node/.claude,type=volume',
      // node_modules as a NAMED VOLUME, not part of the bind-mounted source. This is the load-bearing
      // detail on macOS/Windows: the container's Linux node_modules never lands in the host filesystem
      // (so the host IDE/toolchain can't trip over Linux-native binaries), and the hot path is a native
      // Linux volume instead of a gRPC-FUSE bind, so install + file watching aren't crippled by Docker
      // Desktop's bind-mount latency. Per-project name so volumes don't collide across repos.
      'source=${localWorkspaceFolderBasename}-sandbox-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume',
    ],
    containerEnv: {
      // Don't phone home with telemetry/error reports from inside the sandbox.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };

  // Populate the node_modules volume on create. A named volume mounts as root, but remoteUser is
  // `node`, so chown it first or the install fails with EACCES.
  const FIREWALL = 'sudo /usr/local/bin/init-firewall.sh';
  const install = `sudo chown node:node node_modules && ${pmArgv(pm, 'install', []).join(' ')}`;
  // When the egress firewall is on, apply it BEFORE the create-time install so that install is itself
  // contained (the registry is on the allowlist, so it still works), then re-apply on every start
  // (iptables rules don't survive a container restart). Without the firewall, just install.
  json.postCreateCommand = firewall ? `${FIREWALL} && ${install}` : install;

  if (firewall) {
    // The firewall needs to rewrite iptables; grant exactly those capabilities and re-run the init
    // script on each start (it drops nothing the dev tools need).
    json.runArgs = ['--cap-add=NET_ADMIN', '--cap-add=NET_RAW'];
    json.postStartCommand = FIREWALL;
  }

  const ports = forwardPorts(config);
  if (ports.length) json.forwardPorts = ports;

  return json;
}

/** The repo portion of an image ref (drops `:tag` and `@digest`) for the Renovate annotation. */
function imageRepo(ref: string): string {
  return ref.split('@')[0]!.split(':')[0]!;
}

/**
 * The generated `Dockerfile`. Mirrors the ephemeral image's toolchain + firewall packages.
 * `opts.baseImage` is the fully-resolved base ref (ideally `repo:tag@sha256:…`); the CLI
 * resolves the digest at init time. The `# renovate:` annotation lets Renovate's docker
 * manager keep both the tag and the digest current.
 */
export function devcontainerDockerfile(config: SandboxConfig, opts: { baseImage?: string } = {}): string {
  const baseImage = opts.baseImage ?? BASE_IMAGE;
  const firewall = firewallEnabled(config);
  const lines = [
    '# Generated by `sandbox devcontainer init` from sandbox.config.json.',
    '# Persistent (per-session) counterpart to the ephemeral `sandbox npm install` jail:',
    '# same isolation policy, applied to the whole dev session with the agent inside.',
    `# renovate: datasource=docker depName=${imageRepo(baseImage)}`,
    `FROM ${baseImage}`,
    '',
    '# Native-build toolchain so node-gyp dependencies compile inside the container.',
  ];
  if (firewall) {
    lines.push(
      '# iptables/ipset/dnsutils back the egress firewall (init-firewall.sh).',
      'RUN apt-get update && apt-get install -y --no-install-recommends \\',
      '      python3 make g++ git iptables ipset dnsutils ca-certificates \\',
      '  && rm -rf /var/lib/apt/lists/*',
      '',
      '# Default-deny egress allowing only the apex domains from sandbox.config.json',
      '# (plus the domains Claude Code itself needs). Run at startup via postStartCommand.',
      'COPY init-firewall.sh /usr/local/bin/init-firewall.sh',
      'RUN chmod +x /usr/local/bin/init-firewall.sh \\',
      "  && echo 'node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh' > /etc/sudoers.d/init-firewall \\",
      '  && chmod 0440 /etc/sudoers.d/init-firewall',
    );
  } else {
    lines.push(
      'RUN apt-get update && apt-get install -y --no-install-recommends \\',
      '      python3 make g++ git ca-certificates \\',
      '  && rm -rf /var/lib/apt/lists/*',
    );
  }
  lines.push('', 'USER node', '');
  return lines.join('\n');
}

/**
 * The generated `init-firewall.sh`: default-deny outbound, allowing DNS, established
 * connections, and HTTPS only to the resolved IPs of the allowlisted apex domains.
 * Adapted from the Anthropic reference container, driven by `firewallAllowlist(config)`.
 */
export function initFirewallScript(config: SandboxConfig): string {
  const domains = firewallAllowlist(config);
  return `#!/bin/bash
# Generated by \`sandbox devcontainer init\`. Default-deny egress; allow only the apex
# domains from sandbox.config.json (egress.allow) plus the domains Claude Code needs.
# Edit sandbox.config.json and re-run \`sandbox devcontainer init\`, not this file.
set -euo pipefail

ALLOW_DOMAINS=(
${domains.map((d) => `  "${d}"`).join('\n')}
)

# Reset.
iptables -F; iptables -X; iptables -t nat -F; iptables -t nat -X 2>/dev/null || true
ipset destroy allowed-domains 2>/dev/null || true
ipset create allowed-domains hash:net

# Allow DNS (so we can resolve the allowlist) and loopback before locking down.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT

# Resolve each allowed apex (and its registry/www subdomain) into the ipset.
for domain in "\${ALLOW_DOMAINS[@]}"; do
  for host in "$domain" "registry.$domain" "www.$domain"; do
    getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | while read -r ip; do
      [[ "$ip" =~ ^[0-9.]+$ ]] && ipset add allowed-domains "$ip" 2>/dev/null || true
    done
  done
done

# Allow established/related and traffic to allowlisted IPs; drop the rest.
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
iptables -P OUTPUT DROP
iptables -P FORWARD DROP

# Self-test: a domain that is NOT allowlisted must be unreachable.
if curl --connect-timeout 4 -sf https://example.com >/dev/null 2>&1; then
  echo "init-firewall: FAILED, example.com reachable but should be blocked" >&2
  exit 1
fi
echo "init-firewall: egress locked to ${domains.length} allowed domains"
`;
}

export interface WriteDevcontainerResult {
  files: string[];
  firewall: boolean;
  /** Whether the base image was pinned to a `@sha256:` digest (vs. tag-only fallback). */
  pinned: boolean;
}

/**
 * Write `.devcontainer/{devcontainer.json,Dockerfile[,init-firewall.sh]}` from config.
 * Refuses to overwrite an existing `.devcontainer/devcontainer.json` unless `force`.
 */
export function writeDevcontainer(cwd: string, config: SandboxConfig, opts: { force?: boolean; baseImage?: string } = {}): WriteDevcontainerResult {
  const dir = path.join(cwd, '.devcontainer');
  const jsonPath = path.join(dir, 'devcontainer.json');
  if (existsSync(jsonPath) && !opts.force) {
    throw new Error(`.devcontainer/devcontainer.json already exists (pass --force to overwrite)`);
  }
  mkdirSync(dir, { recursive: true });

  const firewall = firewallEnabled(config);
  const files: string[] = [];

  // The create-time install uses the project's own package manager (Corepack-shimmed for pnpm/yarn).
  const pm = resolvePackageManager(cwd);
  writeFileSync(jsonPath, `${JSON.stringify(devcontainerJson(config, pm), null, 2)}\n`);
  files.push(jsonPath);

  const dockerfilePath = path.join(dir, 'Dockerfile');
  writeFileSync(dockerfilePath, devcontainerDockerfile(config, { baseImage: opts.baseImage }));
  files.push(dockerfilePath);

  if (firewall) {
    const fwPath = path.join(dir, 'init-firewall.sh');
    writeFileSync(fwPath, initFirewallScript(config), { mode: 0o755 });
    files.push(fwPath);
  }

  return { files, firewall, pinned: (opts.baseImage ?? BASE_IMAGE).includes('@sha256:') };
}
