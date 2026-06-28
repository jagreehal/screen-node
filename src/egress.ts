import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { capture, quiet } from './exec.js';

export interface EgressHandle {
  /** The internal (no-route-off-box) network the container must join. */
  network: string;
  /** Proxy env vars to merge into the container so clients route through it. */
  proxyEnv: Record<string, string>;
}

/** Thrown when the egress boundary cannot be established — fail loud, never silently. */
export class EgressError extends Error {
  override name = 'EgressError';
}

/** Run a setup step, throwing with captured stderr if it fails (so the boundary is real). */
async function step(bin: string, args: string[], what: string): Promise<void> {
  const { code, stderr } = await capture(bin, args);
  if (code !== 0) {
    throw new EgressError(`egress: ${what} failed, ${bin} ${args.join(' ')}\n${stderr.trim() || `exit ${code}`}`);
  }
}

/** Extract hosts the proxy refused (the exfil tripwire) from its logs. Pure. */
export function parseEgressDenials(logs: string): string[] {
  const hosts = new Set<string>();
  for (const m of logs.matchAll(/refused on filtered domain "([^"]+)"/g)) {
    if (m[1]) hosts.add(m[1]);
  }
  return [...hosts];
}

async function waitRunning(bin: string, name: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const { code, stdout } = await capture(bin, ['inspect', '-f', '{{.State.Running}}', name]);
    if (code === 0 && stdout.trim() === 'true') return;
    await sleep(100);
  }
  throw new EgressError(`egress: proxy ${name} did not become ready`);
}

/**
 * Stand up a per-invocation egress allowlist, run `fn` inside it, tear it down.
 *
 * Topology: an `--internal` network with no route off-box, plus a default-deny
 * proxy that also sits on a normal network and forwards ONLY to `allow` domains.
 * Names are unique per call so concurrent runs never share a network/proxy and no
 * other container can attach while it's live.
 *
 * Setup failures throw (the boundary is a hard guarantee, not best-effort);
 * teardown is best-effort and always runs.
 */
export async function withEgress<T>(
  bin: string,
  proxyImage: string,
  allow: string[],
  fn: (handle: EgressHandle) => Promise<T>,
  /** Called before teardown with any hosts the proxy refused (the tripwire). */
  onDenials?: (hosts: string[]) => void,
  /** Called before teardown with the proxy's full log text (for canary-token scanning). */
  onLog?: (logText: string) => void,
): Promise<T> {
  const id = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const internal = `sbx_int_${id}`;
  const egress = `sbx_egr_${id}`;
  const proxy = `sbx_proxy_${id}`;

  const url = `http://${proxy}:8888`;
  const proxyEnv: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    YARN_HTTP_PROXY: url,
    YARN_HTTPS_PROXY: url,
    npm_config_proxy: url,
    npm_config_https_proxy: url,
  };

  try {
    await step(bin, ['network', 'create', '--internal', internal], 'create internal network');
    await step(bin, ['network', 'create', egress], 'create egress network');
    // The proxy is a plain HTTP/CONNECT forwarder: it needs no Linux capabilities, so drop
    // them all and block privilege escalation. A compromised allowlist host can't turn the
    // proxy itself into a pivot (e.g. rewriting routes) from in here.
    await step(bin, ['run', '-d', '--rm', '--name', proxy, '--network', internal, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', `ALLOW=${allow.join(',')}`, proxyImage], 'start egress proxy');
    await step(bin, ['network', 'connect', egress, proxy], 'connect proxy to egress network');
    await waitRunning(bin, proxy);
    return await fn({ network: internal, proxyEnv });
  } finally {
    if (onDenials || onLog) {
      // Read the proxy's log BEFORE we tear it down — it holds both the refusals and the request
      // lines a canary nonce would surface in.
      const logs = await capture(bin, ['logs', proxy]);
      const text = `${logs.stdout}\n${logs.stderr}`;
      if (onLog) onLog(text);
      if (onDenials) {
        const denied = parseEgressDenials(text);
        if (denied.length) onDenials(denied);
      }
    }
    await quiet(bin, ['rm', '-f', proxy]);
    await quiet(bin, ['network', 'rm', internal, egress]);
  }
}
